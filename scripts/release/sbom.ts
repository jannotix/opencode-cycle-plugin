import { createHash } from "node:crypto"
import { access, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { NATIVE_PACKAGE_NAMES, PRODUCT_IDENTITY } from "../product-identity.js"

export interface CargoMetadata {
  readonly packages: readonly {
    readonly id: string
    readonly license: string | null
    readonly name: string
    readonly source: string | null
    readonly version: string
  }[]
  readonly resolve: {
    readonly nodes: readonly {
      readonly deps: readonly {
        readonly dep_kinds: readonly { readonly kind: string | null }[]
        readonly pkg: string
      }[]
      readonly id: string
    }[]
    readonly root: string | null
  } | null
}

export interface JavaScriptPackage {
  readonly dependencies: readonly string[]
  readonly license: string | null
  readonly name: string
  readonly version: string
}

export interface ArtifactComponent {
  readonly digest: string
  readonly name: string
}

interface BomComponent {
  readonly "bom-ref": string
  readonly hashes?: readonly { readonly alg: "SHA-256"; readonly content: string }[]
  readonly licenses?: readonly { readonly expression: string }[]
  readonly name: string
  readonly purl?: string
  readonly type: "application" | "file" | "library"
  readonly version?: string
}

interface BomDependency {
  readonly dependsOn: readonly string[]
  readonly ref: string
}

export interface CycloneDxBom {
  readonly bomFormat: "CycloneDX"
  readonly components: readonly BomComponent[]
  readonly dependencies: readonly BomDependency[]
  readonly metadata: {
    readonly component: BomComponent
    readonly tools: { readonly components: readonly BomComponent[] }
  }
  readonly specVersion: "1.6"
  readonly version: 1
}

export function buildCycloneDxBom(
  cargo: CargoMetadata,
  cargoRoot: string,
  javascript: readonly JavaScriptPackage[],
  javascriptRoots: readonly string[],
  artifacts: readonly ArtifactComponent[],
): CycloneDxBom {
  const cargoPackages = new Map(cargo.packages.map((item) => [item.id, item]))
  const cargoNodes = new Map((cargo.resolve?.nodes ?? []).map((node) => [node.id, node]))
  const cargoReachable = traverse([cargoRoot], (id) =>
    (cargoNodes.get(id)?.deps ?? [])
      .filter((dependency) => dependency.dep_kinds.some((kind) => kind.kind !== "dev"))
      .map((dependency) => dependency.pkg),
  )
  const javascriptPackages = new Map(javascript.map((item) => [`${item.name}@${item.version}`, item]))
  const javascriptReachable = traverse(javascriptRoots, (id) => javascriptPackages.get(id)?.dependencies ?? [])

  const components: BomComponent[] = []
  const dependencies: BomDependency[] = []
  for (const id of [...cargoReachable].sort()) {
    const item = cargoPackages.get(id)
    if (item === undefined) throw new Error(`Cargo metadata is missing package ${id}`)
    const ref = cargoRef(item.name, item.version)
    components.push(component(ref, item.name, item.version, item.license, "cargo"))
    dependencies.push({
      dependsOn: (cargoNodes.get(id)?.deps ?? [])
        .filter(
          (dependency) =>
            cargoReachable.has(dependency.pkg) &&
            dependency.dep_kinds.some((kind) => kind.kind !== "dev"),
        )
        .map((dependency) => {
          const target = cargoPackages.get(dependency.pkg)
          if (target === undefined) throw new Error(`Cargo metadata is missing package ${dependency.pkg}`)
          return cargoRef(target.name, target.version)
        })
        .sort(),
      ref,
    })
  }
  for (const id of [...javascriptReachable].sort()) {
    const item = javascriptPackages.get(id)
    if (item === undefined) throw new Error(`JavaScript inventory is missing package ${id}`)
    const ref = npmRef(item.name, item.version)
    components.push(component(ref, item.name, item.version, item.license, "npm"))
    dependencies.push({
      dependsOn: item.dependencies
        .filter((dependency) => javascriptReachable.has(dependency))
        .map((dependency) => {
          const target = javascriptPackages.get(dependency)
          if (target === undefined) throw new Error(`JavaScript inventory is missing package ${dependency}`)
          return npmRef(target.name, target.version)
        })
        .sort(),
      ref,
    })
  }
  for (const artifact of [...artifacts].sort((left, right) => left.name.localeCompare(right.name))) {
    validateDigest(artifact.digest)
    if (basename(artifact.name) !== artifact.name) throw new Error("Artifact names must not contain paths")
    components.push({
      "bom-ref": `urn:sha256:${artifact.digest}`,
      hashes: [{ alg: "SHA-256", content: artifact.digest }],
      name: artifact.name,
      type: "file",
    })
  }
  components.sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]))
  dependencies.sort((left, right) => left.ref.localeCompare(right.ref))

  return {
    bomFormat: "CycloneDX",
    components,
    dependencies,
    metadata: {
      component: {
        "bom-ref": "pkg:github/jannotix/opencode-cycle-plugin",
        name: PRODUCT_IDENTITY.product,
        type: "application",
      },
      tools: {
        components: [
          {
            "bom-ref": "pkg:generic/opencode-cycle-sbom-generator@1",
            name: `${PRODUCT_IDENTITY.product} SBOM generator`,
            type: "application",
            version: "1",
          },
        ],
      },
    },
    specVersion: "1.6",
    version: 1,
  }
}

export async function collectJavaScriptInventory(
  workspaceRoot: string,
  packageDirectories: readonly string[],
): Promise<JavaScriptPackage[]> {
  const queue = [...packageDirectories.map((directory) => resolve(directory))]
  const records = new Map<string, JavaScriptPackage>()
  while (queue.length > 0) {
    const directory = queue.shift() as string
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      dependencies?: Readonly<Record<string, string>>
      license?: unknown
      name?: unknown
      optionalDependencies?: Readonly<Record<string, string>>
      version?: unknown
    }
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Production package has invalid identity: ${directory}`)
    }
    const identity = `${manifest.name}@${manifest.version}`
    if (records.has(identity)) continue
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ].sort()
    const dependencies: string[] = []
    for (const name of dependencyNames) {
      const target = await resolveInstalledPackage(directory, workspaceRoot, name)
      if (target === undefined) continue
      const targetManifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
        name?: unknown
        version?: unknown
      }
      if (typeof targetManifest.name !== "string" || typeof targetManifest.version !== "string") {
        throw new Error(`Installed dependency has invalid identity: ${target}`)
      }
      dependencies.push(`${targetManifest.name}@${targetManifest.version}`)
      queue.push(target)
    }
    records.set(identity, {
      dependencies: [...new Set(dependencies)].sort(),
      license: typeof manifest.license === "string" ? manifest.license : null,
      name: manifest.name,
      version: manifest.version,
    })
  }
  return [...records.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )
}

async function main(): Promise<void> {
  const argumentsMap = parseArguments(Bun.argv.slice(2))
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const cargoOutput = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--locked"], {
    cwd: root,
    stderr: "inherit",
  })
  if (cargoOutput.exitCode !== 0) throw new Error("cargo metadata failed")
  const cargo = JSON.parse(cargoOutput.stdout.toString()) as CargoMetadata
  const cargoRoot = cargo.packages.find((item) => item.name === "workflowd")?.id
  if (cargoRoot === undefined) throw new Error("workflowd is missing from Cargo metadata")

  const packageDirectories = [
    join(root, "packages", PRODUCT_IDENTITY.mainPackage),
    ...NATIVE_PACKAGE_NAMES.map((name) =>
      join(root, "packages", name.slice(name.lastIndexOf("/") + 1)),
    ),
  ]
  const javascript = await collectJavaScriptInventory(root, packageDirectories)
  const roots = await Promise.all(
    packageDirectories.map(async (directory) => {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name: string
        version: string
      }
      return `${manifest.name}@${manifest.version}`
    }),
  )
  const artifacts = await Promise.all(
    argumentsMap.artifacts.map(async (path) => ({
      digest: await digest(resolve(path)),
      name: basename(path),
    })),
  )
  const bom = buildCycloneDxBom(cargo, cargoRoot, javascript, roots, artifacts)
  await writeFile(resolve(argumentsMap.output), `${JSON.stringify(bom, null, 2)}\n`, "utf8")
}

function component(
  ref: string,
  name: string,
  version: string,
  license: string | null,
  packageType: "cargo" | "npm",
): BomComponent {
  return {
    "bom-ref": ref,
    ...(license === null ? {} : { licenses: [{ expression: license }] }),
    name,
    purl: packageType === "cargo" ? cargoRef(name, version) : npmRef(name, version),
    type: "library",
    version,
  }
}

function cargoRef(name: string, version: string): string {
  return `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

function npmRef(name: string, version: string): string {
  const encoded = encodeURIComponent(name).replace("%2F", "/")
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`
}

function traverse(roots: readonly string[], edges: (id: string) => readonly string[]): Set<string> {
  const reachable = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (reachable.has(id)) continue
    reachable.add(id)
    queue.push(...edges(id))
  }
  return reachable
}

async function resolveInstalledPackage(
  issuer: string,
  workspaceRoot: string,
  name: string,
): Promise<string | undefined> {
  let current = issuer
  const boundary = resolve(workspaceRoot)
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"))
    if (await exists(join(candidate, "package.json"))) return candidate
    if (current === boundary) return undefined
    const parent = dirname(current)
    if (parent === current || !parent.startsWith(boundary)) return undefined
    current = parent
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function validateDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Invalid SHA-256 digest: ${value}`)
}

function parseArguments(argumentsList: readonly string[]): { artifacts: string[]; output: string } {
  const artifacts: string[] = []
  let output: string | undefined
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    const value = argumentsList[index + 1]
    if (argument === "--artifact" && value !== undefined) {
      artifacts.push(value)
      index += 1
    } else if (argument === "--output" && value !== undefined) {
      output = value
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`)
    }
  }
  if (output === undefined) throw new Error("Expected --output <path>")
  return { artifacts, output }
}

if (import.meta.main) await main()
