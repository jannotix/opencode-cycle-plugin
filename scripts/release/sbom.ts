import { access, readFile, realpath, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

import { PRODUCT_IDENTITY } from "../product-identity.js"
import { inspectTarGz } from "../packaging/tar-archive.js"
import {
  assertArtifactInventoryMatchesManifest,
  readReleaseManifest,
  type ReleaseArtifact,
} from "./release-manifest.js"
import { readVerifiedFileDirectory, readVerifiedRegularFile, type VerifiedFile } from "./verified-file.js"

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
  readonly size: number
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
  readonly $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json"
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
  manifestArtifacts: readonly ReleaseArtifact[] = artifacts.map((artifact) => ({
    name: artifact.name,
    sha256: artifact.digest,
    size: artifact.size,
  })),
): CycloneDxBom {
  assertArtifactInventoryMatchesManifest(
    artifacts.map((artifact) => ({
      name: artifact.name,
      sha256: artifact.digest,
      size: artifact.size,
    })),
    manifestArtifacts,
  )
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
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
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
      if (target === undefined) {
        throw new Error(`Required production dependency is missing: ${name}`)
      }
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

interface PackedManifest {
  readonly dependencies: Readonly<Record<string, string>>
  readonly license: string
  readonly name: string
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly version: string
}

export async function collectPackedJavaScriptInventory(
  workspaceRoot: string,
  artifacts: readonly VerifiedFile[],
  releaseVersion: string,
  lockText: string,
): Promise<{ packages: JavaScriptPackage[]; roots: string[] }> {
  const lock = parseBunLock(lockText)
  const expectedNames = new Map([
    [`opencode-cycle-${releaseVersion}.tgz`, PRODUCT_IDENTITY.mainPackage],
    [`opencode-cycle-native-linux-x64-${releaseVersion}.tgz`, "@opencode-cycle/native-linux-x64"],
    [`opencode-cycle-native-win32-x64-${releaseVersion}.tgz`, "@opencode-cycle/native-win32-x64"],
  ])
  if (artifacts.length !== expectedNames.size) {
    throw new Error("Packed JavaScript artifact set is incomplete")
  }
  const packed = new Map<string, PackedManifest>()
  for (const artifact of artifacts) {
    const expectedName = expectedNames.get(artifact.name)
    if (expectedName === undefined) throw new Error(`Packed JavaScript artifact is unsupported: ${artifact.name}`)
    const entries = inspectTarGz(artifact.content)
    const manifests = entries.filter((entry) => entry.name === "package/package.json")
    if (manifests.length !== 1) {
      throw new Error(`Packed artifact must contain exactly one package manifest: ${artifact.name}`)
    }
    const manifest = parsePackedManifest(manifests[0]?.content)
    if (manifest.name !== expectedName || manifest.version !== releaseVersion) {
      throw new Error(`Packed artifact identity does not match its allowlist: ${artifact.name}`)
    }
    assertPackedManifestAllowlist(manifest)
    assertPackedManifestMatchesLock(manifest, lock)
    if (packed.has(manifest.name)) throw new Error(`Packed package identity is duplicated: ${manifest.name}`)
    packed.set(manifest.name, manifest)
  }

  const records = new Map<string, JavaScriptPackage>()
  const lockedPackages = parseLockedPackages(lock)
  const resolvedNodes = new Map<string, string>()
  const installedNodes = new Map<string, string>()
  const visiting = new Set<string>()
  const visit = async (
    name: string,
    requirement: string,
    relationship: LockedRelationship = "dependency",
    issuerDirectory: string = workspaceRoot,
    issuerNode?: LockedPackage,
    allowLockOnly = false,
  ): Promise<string | undefined> => {
    const packedManifest = packed.get(name)
    if (packedManifest !== undefined) {
      assertVersionSatisfies(name, packedManifest.version, requirement)
      return `${name}@${packedManifest.version}`
    }
    const locked = resolveLockedPackage(lockedPackages, name, requirement, relationship, issuerNode)
    if (locked === undefined) return undefined
    if (!isReleaseTargetApplicable(locked)) {
      if (isOptionalRelationship(relationship)) return undefined
      throw new Error(`Required production ${relationship} is outside the Windows/Linux x64 union: ${name}`)
    }
    const identity = `${locked.name}@${locked.version}`
    if (visiting.has(locked.key)) {
      throw new Error(`bun.lock production dependency cycle includes ${locked.key}`)
    }
    const installed = await resolveInstalledPackage(issuerDirectory, workspaceRoot, name)
    let installedLicense: string | null = null
    let lockOnly = allowLockOnly
    if (installed === undefined) {
      const otherReleaseTarget = isOptionalRelationship(relationship) &&
        hasTargetRestriction(locked) &&
        !isCurrentTargetApplicable(locked)
      if (!lockOnly && !otherReleaseTarget) {
        if (isOptionalRelationship(relationship)) return undefined
        throw new Error(`Required locked production ${relationship} is missing: ${name}`)
      }
      lockOnly = true
    } else {
      const installedRealpath = await realpath(installed)
      const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
        license?: unknown
        name?: unknown
        version?: unknown
      }
      if (installedManifest.name !== name || installedManifest.version !== locked.version) {
        throw new Error(`Installed ${relationship} does not match bun.lock: ${name}`)
      }
      const priorInstalled = installedNodes.get(locked.key)
      if (priorInstalled !== undefined && priorInstalled !== installedRealpath) {
        throw new Error(`Installed dependency resolution is ambiguous for bun.lock node: ${locked.key}`)
      }
      installedNodes.set(locked.key, installedRealpath)
      installedLicense = typeof installedManifest.license === "string" ? installedManifest.license : null
    }
    const priorIdentity = resolvedNodes.get(locked.key)
    if (priorIdentity !== undefined) {
      const priorRecord = records.get(priorIdentity)
      if (
        priorRecord !== undefined &&
        priorRecord.license === null &&
        installedLicense !== null &&
        !hasTargetRestriction(locked)
      ) {
        records.set(priorIdentity, { ...priorRecord, license: installedLicense })
      }
      return priorIdentity
    }

    visiting.add(locked.key)
    try {
      const dependencies: string[] = []
      for (const edge of lockedEdges(locked)) {
        const dependency = await visit(
          edge.name,
          edge.requirement,
          edge.relationship,
          installed ?? issuerDirectory,
          locked,
          lockOnly,
        )
        if (dependency !== undefined) dependencies.push(dependency)
      }
      const record = {
        dependencies: [...new Set(dependencies)].sort(),
        license: hasTargetRestriction(locked) ? null : installedLicense,
        name: locked.name,
        version: locked.version,
      } satisfies JavaScriptPackage
      const priorRecord = records.get(identity)
      if (priorRecord !== undefined) {
        if (
          JSON.stringify(priorRecord.dependencies) !== JSON.stringify(record.dependencies) ||
          (priorRecord.license !== null && record.license !== null && priorRecord.license !== record.license)
        ) {
          throw new Error(`bun.lock package identity has ambiguous dependency graphs: ${identity}`)
        }
        records.set(identity, {
          ...record,
          license: priorRecord.license ?? record.license,
        })
      } else {
        records.set(identity, record)
      }
      resolvedNodes.set(locked.key, identity)
      return identity
    } finally {
      visiting.delete(locked.key)
    }
  }

  const roots: string[] = []
  for (const manifest of [...packed.values()].sort((left, right) => left.name.localeCompare(right.name))) {
    const edges: LockedEdge[] = [
      ...Object.entries(manifest.dependencies).map(([name, requirement]) => ({
        name,
        relationship: "dependency" as const,
        requirement,
      })),
      ...Object.entries(manifest.optionalDependencies).map(([name, requirement]) => ({
        name,
        relationship: "optional dependency" as const,
        requirement,
      })),
    ].sort((left, right) => left.name.localeCompare(right.name))
    const dependencies: string[] = []
    for (const edge of edges) {
      const dependency = await visit(edge.name, edge.requirement, edge.relationship)
      if (dependency !== undefined) dependencies.push(dependency)
    }
    const identity = `${manifest.name}@${manifest.version}`
    records.set(identity, {
      dependencies: [...new Set(dependencies)].sort(),
      license: manifest.license,
      name: manifest.name,
      version: manifest.version,
    })
    roots.push(identity)
  }
  return {
    packages: [...records.values()].sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    ),
    roots: roots.sort(),
  }
}

interface ParsedBunLock {
  readonly packages: Record<string, unknown>
  readonly workspaces: Record<string, unknown>
}

interface LockedPackage {
  readonly cpu?: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly key: string
  readonly name: string
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly optionalPeers: readonly string[]
  readonly os?: string
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly version: string
}

type LockedRelationship = "dependency" | "optional dependency" | "peer" | "optional peer"

interface LockedEdge {
  readonly name: string
  readonly relationship: LockedRelationship
  readonly requirement: string
}

const RELEASE_TARGETS = [
  { cpu: "x64", os: "win32" },
  { cpu: "x64", os: "linux" },
] as const

function parseBunLock(text: string): ParsedBunLock {
  const value = Bun.JSONC.parse(text) as unknown
  if (!isRecord(value) || !isRecord(value.packages) || !isRecord(value.workspaces)) {
    throw new Error("bun.lock is malformed")
  }
  return value as unknown as ParsedBunLock
}

function parsePackedManifest(content: Uint8Array | undefined): PackedManifest {
  if (content === undefined) throw new Error("Packed package manifest is missing")
  const value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.license !== "string"
  ) {
    throw new Error("Packed package manifest identity is invalid")
  }
  return {
    dependencies: stringMap(value.dependencies, "packed dependencies"),
    license: value.license,
    name: value.name,
    optionalDependencies: stringMap(value.optionalDependencies, "packed optional dependencies"),
    version: value.version,
  }
}

function assertPackedManifestAllowlist(manifest: PackedManifest): void {
  const dependencies = manifest.name === PRODUCT_IDENTITY.mainPackage
    ? {
        "@opencode-ai/plugin": "1.18.21",
        "@opencode-ai/sdk": "1.18.21",
        "puppeteer-core": "25.6.0",
      }
    : {}
  const optionalDependencies = manifest.name === PRODUCT_IDENTITY.mainPackage
    ? {
        "@opencode-cycle/native-linux-x64": "1.0.0",
        "@opencode-cycle/native-win32-x64": "1.0.0",
      }
    : {}
  if (
    manifest.license !== "FSL-1.1-MIT" ||
    JSON.stringify(manifest.dependencies) !== JSON.stringify(dependencies) ||
    JSON.stringify(manifest.optionalDependencies) !== JSON.stringify(optionalDependencies)
  ) {
    throw new Error(`Packed package dependencies are outside the production allowlist: ${manifest.name}`)
  }
}

function assertPackedManifestMatchesLock(manifest: PackedManifest, lock: ParsedBunLock): void {
  const workspace = Object.values(lock.workspaces).find(
    (candidate) => isRecord(candidate) && candidate.name === manifest.name,
  )
  if (!isRecord(workspace) || workspace.version !== manifest.version) {
    throw new Error(`Packed package is missing from bun.lock workspaces: ${manifest.name}`)
  }
  if (
    JSON.stringify(stringMap(workspace.dependencies, "locked workspace dependencies")) !==
      JSON.stringify(manifest.dependencies) ||
    JSON.stringify(stringMap(workspace.optionalDependencies, "locked workspace optional dependencies")) !==
      JSON.stringify(manifest.optionalDependencies)
  ) {
    throw new Error(`Packed package dependencies do not match bun.lock: ${manifest.name}`)
  }
}

function parseLockedPackages(lock: ParsedBunLock): ReadonlyMap<string, LockedPackage> {
  const packages = new Map<string, LockedPackage>()
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
      throw new Error(`bun.lock package entry is malformed: ${key}`)
    }
    const separator = value[0].lastIndexOf("@")
    const name = value[0].slice(0, separator)
    const version = value[0].slice(separator + 1)
    if (version.startsWith("workspace:")) continue
    if (
      separator <= 0 ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ||
      (key !== name && !key.endsWith(`/${name}`))
    ) {
      throw new Error(`Locked dependency identity is invalid: ${key}`)
    }
    const metadata = isRecord(value[2]) ? value[2] : {}
    const peerDependencies = stringMap(metadata.peerDependencies, `locked peer dependencies for ${key}`)
    const optionalPeers = stringList(metadata.optionalPeers, `locked optional peers for ${key}`)
    const unknownOptionalPeer = optionalPeers.find((peer) => peerDependencies[peer] === undefined)
    if (unknownOptionalPeer !== undefined) {
      throw new Error(`Locked optional peer is missing from peerDependencies for ${key}: ${unknownOptionalPeer}`)
    }
    packages.set(key, {
      ...(metadata.cpu === undefined ? {} : { cpu: requiredString(metadata.cpu, `locked cpu for ${key}`) }),
      dependencies: stringMap(metadata.dependencies, `locked dependencies for ${key}`),
      key,
      name,
      optionalDependencies: stringMap(
        metadata.optionalDependencies,
        `locked optional dependencies for ${key}`,
      ),
      optionalPeers,
      ...(metadata.os === undefined ? {} : { os: requiredString(metadata.os, `locked os for ${key}`) }),
      peerDependencies,
      version,
    })
  }
  return packages
}

function resolveLockedPackage(
  packages: ReadonlyMap<string, LockedPackage>,
  name: string,
  requirement: string,
  relationship: LockedRelationship,
  issuer?: LockedPackage,
): LockedPackage | undefined {
  const candidateKeys: string[] = []
  let current = issuer
  while (current !== undefined) {
    candidateKeys.push(`${current.key}/${name}`)
    const qualifier = lockQualifier(current)
    if (qualifier === undefined) break
    current = packages.get(qualifier)
    if (current === undefined) {
      throw new Error(`bun.lock issuer ancestry is missing: ${qualifier}`)
    }
  }
  candidateKeys.push(name)
  for (const key of [...new Set(candidateKeys)]) {
    const candidate = packages.get(key)
    if (candidate === undefined) continue
    if (candidate.name !== name) throw new Error(`bun.lock dependency key has the wrong identity: ${key}`)
    assertVersionSatisfies(name, candidate.version, requirement)
    return candidate
  }

  const matches = [...packages.values()].filter((candidate) => candidate.name === name)
  if (matches.length > 1) {
    throw new Error(`Production ${relationship} is ambiguous in bun.lock: ${name}`)
  }
  if (isOptionalRelationship(relationship)) return undefined
  throw new Error(`Required production ${relationship} cannot be resolved from bun.lock: ${name}`)
}

function lockQualifier(value: LockedPackage): string | undefined {
  if (value.key === value.name) return undefined
  const suffix = `/${value.name}`
  if (!value.key.endsWith(suffix)) throw new Error(`bun.lock package key is malformed: ${value.key}`)
  return value.key.slice(0, -suffix.length)
}

function assertVersionSatisfies(name: string, version: string, requirement: string): void {
  if (!Bun.semver.satisfies(version, requirement)) {
    throw new Error(`Locked dependency ${name}@${version} does not satisfy bun.lock requirement ${requirement}`)
  }
}

function lockedEdges(value: LockedPackage): readonly LockedEdge[] {
  const optionalPeerSet = new Set(value.optionalPeers)
  return [
    ...Object.entries(value.dependencies).map(([name, requirement]) => ({
      name,
      relationship: "dependency" as const,
      requirement,
    })),
    ...Object.entries(value.optionalDependencies).map(([name, requirement]) => ({
      name,
      relationship: "optional dependency" as const,
      requirement,
    })),
    ...Object.entries(value.peerDependencies).map(([name, requirement]) => ({
      name,
      relationship: optionalPeerSet.has(name) ? "optional peer" as const : "peer" as const,
      requirement,
    })),
  ].sort((left, right) =>
    `${left.name}\0${left.relationship}`.localeCompare(`${right.name}\0${right.relationship}`),
  )
}

function isOptionalRelationship(value: LockedRelationship): boolean {
  return value === "optional dependency" || value === "optional peer"
}

function isReleaseTargetApplicable(value: LockedPackage): boolean {
  return RELEASE_TARGETS.some(
    (target) =>
      (value.os === undefined || value.os === target.os) &&
      (value.cpu === undefined || value.cpu === target.cpu),
  )
}

function isCurrentTargetApplicable(value: LockedPackage): boolean {
  return (value.os === undefined || value.os === process.platform) &&
    (value.cpu === undefined || value.cpu === process.arch)
}

function hasTargetRestriction(value: LockedPackage): boolean {
  return value.os !== undefined || value.cpu !== undefined
}

function stringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string map`)
  }
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, string>
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a string list`)
  }
  const sorted = [...value].sort()
  if (new Set(sorted).size !== sorted.length) throw new Error(`${label} must not contain duplicates`)
  return sorted
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function main(): Promise<void> {
  const argumentsMap = parseArguments(Bun.argv.slice(2))
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const manifest = await readReleaseManifest(argumentsMap.manifest)
  const verifiedArtifacts = await readVerifiedFileDirectory(argumentsMap.artifactsDirectory)
  const artifactInventory = verifiedArtifacts.map(({ name, sha256, size }) => ({ name, sha256, size }))
  assertArtifactInventoryMatchesManifest(artifactInventory, manifest.artifacts)
  const lock = await readVerifiedRegularFile(join(root, "bun.lock"), { maxBytes: 10 * 1024 * 1024 })
  const javascriptInventory = await collectPackedJavaScriptInventory(
    root,
    verifiedArtifacts,
    manifest.version,
    lock.content.toString("utf8"),
  )
  const cargoOutput = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--locked"], {
    cwd: root,
    stderr: "inherit",
  })
  if (cargoOutput.exitCode !== 0) throw new Error("cargo metadata failed")
  const cargo = JSON.parse(cargoOutput.stdout.toString()) as CargoMetadata
  const cargoRoot = cargo.packages.find((item) => item.name === "workflowd")?.id
  if (cargoRoot === undefined) throw new Error("workflowd is missing from Cargo metadata")

  const artifacts = verifiedArtifacts.map((artifact) => ({
    digest: artifact.sha256,
    name: artifact.name,
    size: artifact.size,
  }))
  const bom = buildCycloneDxBom(
    cargo,
    cargoRoot,
    javascriptInventory.packages,
    javascriptInventory.roots,
    artifacts,
    manifest.artifacts,
  )
  await validateCycloneDxBom(bom)
  await writeFile(resolve(argumentsMap.output), `${JSON.stringify(bom, null, 2)}\n`, "utf8")
}

interface JsonValidator {
  (value: unknown): boolean
  readonly errors?: readonly { readonly instancePath: string; readonly message?: string }[] | null
}

interface JsonSchemaCompiler {
  addFormat(name: string, format: RegExp): void
  addSchema(schema: object): void
  compile(schema: object): JsonValidator
}

interface JsonSchemaCompilerConstructor {
  new(options: { readonly allErrors: boolean; readonly strict: boolean }): JsonSchemaCompiler
}

const require = createRequire(import.meta.url)
const Ajv = require("ajv") as JsonSchemaCompilerConstructor
const addFormats = require("ajv-formats") as (compiler: JsonSchemaCompiler) => void

let schemaValidator: Promise<JsonValidator> | undefined

export async function validateCycloneDxBom(bom: unknown): Promise<void> {
  if (!isRecord(bom) || bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.6") {
    throw new Error("CycloneDX 1.6 schema validation failed: identity is not exact")
  }
  schemaValidator ??= (async () => {
    const schemaRoot = join(import.meta.dir, "schema")
    const [schema, spdx, jsf] = await Promise.all(
      [
        ["bom-1.6.schema.json", "a45bb932df5a0469dd9e50534bbf755cb62e562187d2ade54a6d2156885e7810"],
        ["spdx.schema.json", "4538b2231bd5196c9c6de17ffc5d8e17423b2533bd73704ac1bd8ae960407a6b"],
        ["jsf-0.82.schema.json", "a8a19aefb25c8b868326e44fe40d1923d5b5c72c1975f31dd1e4d11b08732105"],
      ].map(async ([name, expectedDigest]) => {
        const content = await readFile(join(schemaRoot, name as string))
        const digest = createHash("sha256").update(content).digest("hex")
        if (digest !== expectedDigest) throw new Error(`Vendored CycloneDX schema digest changed: ${name}`)
        return JSON.parse(content.toString("utf8")) as object
      }),
    )
    if (schema === undefined || spdx === undefined || jsf === undefined) {
      throw new Error("CycloneDX 1.6 local schema set is incomplete")
    }
    const ajv = new Ajv({ allErrors: true, strict: false })
    addFormats(ajv)
    ajv.addFormat("idn-email", /^[^\s@]+@[^\s@]+$/u)
    ajv.addFormat("iri-reference", /^\S*$/u)
    ajv.addSchema(spdx)
    ajv.addSchema(jsf)
    return ajv.compile(schema)
  })()
  const validate = await schemaValidator
  if (!validate(bom)) {
    throw new Error(`CycloneDX 1.6 schema validation failed: ${validate.errors?.map((item) => `${item.instancePath} ${item.message}`).join("; ")}`)
  }
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
  let current = await realpath(issuer)
  const boundary = await realpath(workspaceRoot)
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

function validateDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Invalid SHA-256 digest: ${value}`)
}

function parseArguments(argumentsList: readonly string[]): {
  artifactsDirectory: string
  manifest: string
  output: string
} {
  const values = new Map<string, string>()
  const allowed = new Set(["artifacts-directory", "manifest", "output"])
  for (let index = 0; index < argumentsList.length; index += 2) {
    const argument = argumentsList[index]
    const value = argumentsList[index + 1]
    if (argument === undefined || value === undefined || !argument.startsWith("--")) {
      throw new Error("SBOM arguments must be --key value pairs")
    }
    const name = argument.slice(2)
    if (!allowed.has(name) || values.has(name)) {
      throw new Error(`Unknown or duplicate argument: ${argument}`)
    }
    values.set(name, value)
  }
  for (const name of allowed) if (!values.has(name)) throw new Error(`Missing --${name}`)
  return {
    artifactsDirectory: values.get("artifacts-directory") as string,
    manifest: values.get("manifest") as string,
    output: values.get("output") as string,
  }
}

if (import.meta.main) await main()
