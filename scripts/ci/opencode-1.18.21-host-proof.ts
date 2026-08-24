import { createHash } from "node:crypto"
import { access, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// No-network executable extraction of the v1.18.21 server-plugin path. The
// schema, origin merge/dedup, file target/entry resolution, module load and
// legacy function application below follow the checksum-pinned upstream files.
// Keep this adapter immutable unless every provenance and adapter digest is
// independently refreshed against the official tag.

import {
  desktopCertificationBindingDigest,
  type DesktopCertificationBinding,
} from "../../packages/opencode-cycle/src/certification.js"

export const OPENCODE_11821_HOST_PROOF_PROVENANCE = {
  commit: "826d9ad46a22bef0294998e08daa3c4904fea28f",
  files: {
    "packages/core/src/v1/config/plugin.ts": "47f1990fd214247bc9813c7e3917fd651575fc5c11d3eb0aacdea3687dfe142c",
    "packages/opencode/src/config/config.ts": "cd94580e88849c917fc619e344bf0a6bf2b235cbc6967318d3a664ec1dd986db",
    "packages/opencode/src/config/paths.ts": "5035696f4213749075942c09e39f635ee730ea37217f4ad4aecac64645ae2d39",
    "packages/opencode/src/config/plugin.ts": "b5f73247aea65adeeebbf2cc60acbc96c7980c96e4d58518d733216a17fc264b",
    "packages/opencode/src/plugin/index.ts": "e8cc96d7eb486aafa0d1dbb793e7f0e326df4981a399f958c54d496a0226956f",
    "packages/opencode/src/plugin/loader.ts": "e62ac4ee752c4f7cbbd5525eaeafc8565ba0763c55985584393ea513a1f9678d",
    "packages/opencode/src/plugin/shared.ts": "db714592eeeb8362e8a92899ec434e5f6521a4446980426a2d7ced724fb7cffb",
  },
  tag: "v1.18.21",
} as const

type PluginOptions = Record<string, unknown>
type PluginSpec = string | [string, PluginOptions]
type PluginOrigin = { readonly scope: "global" | "local"; readonly source: string; readonly spec: PluginSpec }

export interface OpenCodeHostProofRequest {
  readonly binding: DesktopCertificationBinding
  readonly candidatePackageRoot: string
  readonly configFile: string
  readonly directory: string
  readonly disposeAfterLoad?: boolean
  readonly resultFile: string
  readonly worktree: string
}

export interface OpenCodeHostProofReceipt {
  readonly bindingDigest: string
  readonly candidateEntrySha256: string
  readonly deduplicatedOrigins: number
  readonly loadedPlugins: number
  readonly mergedOrigins: number
  readonly optionsDigest: string
  readonly provenanceCommit: string
  readonly tupleOptions: true
}

export async function runOpenCode11821HostProof(
  request: OpenCodeHostProofRequest,
): Promise<OpenCodeHostProofReceipt> {
  const config = JSON.parse(await readFile(request.configFile, "utf8")) as { plugin?: unknown }
  const specs = parsePluginSpecs(config.plugin)
  if (specs.length !== 1 || !Array.isArray(specs[0])) {
    throw new Error("OpenCode 1.18.21 host proof requires one tuple plugin spec")
  }
  const origins: PluginOrigin[] = [
    { scope: "global", source: "global-config", spec: specs[0] },
    { scope: "local", source: request.configFile, spec: specs[0] },
    { scope: "local", source: dirname(request.configFile), spec: specs[0] },
  ]
  const deduplicated = deduplicatePluginOrigins(origins)
  if (deduplicated.length !== 1) throw new Error("OpenCode 1.18.21 plugin origin deduplication failed")
  const origin = deduplicated[0] as PluginOrigin
  const specifier = pluginSpecifier(origin.spec)
  const options = pluginOptions(origin.spec)
  if (options === undefined) throw new Error("OpenCode 1.18.21 tuple options disappeared")
  assertExactCertificationOptions(options, request.binding)

  const target = await resolvePathPluginTarget(specifier)
  const entry = await createServerPluginEntry(target)
  const module = await import(entry)
  const plugins = legacyServerPlugins(module as Record<string, unknown>)
  if (plugins.length !== 1) throw new Error("OpenCode 1.18.21 loaded an unexpected plugin export set")

  const input = officialPluginInput(request.directory, request.worktree)
  const hooks = await (plugins[0] as (input: unknown, options: PluginOptions) => Promise<Record<string, unknown>>)(
    input,
    options,
  )
  if (request.disposeAfterLoad && typeof hooks.dispose === "function") {
    await (hooks.dispose as () => Promise<void>)()
  }

  const candidateEntry = await resolveCandidateExport(request.candidatePackageRoot)
  const receipt: OpenCodeHostProofReceipt = {
    bindingDigest: desktopCertificationBindingDigest(request.binding),
    candidateEntrySha256: await digest(candidateEntry),
    deduplicatedOrigins: deduplicated.length,
    loadedPlugins: plugins.length,
    mergedOrigins: origins.length,
    optionsDigest: createHash("sha256").update(JSON.stringify(options)).digest("hex"),
    provenanceCommit: OPENCODE_11821_HOST_PROOF_PROVENANCE.commit,
    tupleOptions: true,
  }
  await writeFile(request.resultFile, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 })
  return receipt
}

function parsePluginSpecs(value: unknown): PluginSpec[] {
  if (!Array.isArray(value)) throw new Error("OpenCode 1.18.21 plugin config is not an array")
  return value.map((item) => {
    if (typeof item === "string") return item
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      typeof item[0] === "string" &&
      isRecord(item[1])
    ) return [item[0], item[1]]
    throw new Error("OpenCode 1.18.21 plugin config has an invalid spec")
  })
}

function pluginSpecifier(plugin: PluginSpec): string {
  return Array.isArray(plugin) ? plugin[0] : plugin
}

function pluginOptions(plugin: PluginSpec): PluginOptions | undefined {
  return Array.isArray(plugin) ? plugin[1] : undefined
}

function deduplicatePluginOrigins(origins: PluginOrigin[]): PluginOrigin[] {
  const seen = new Set<string>()
  const list: PluginOrigin[] = []
  for (const origin of origins.toReversed()) {
    const specifier = pluginSpecifier(origin.spec)
    if (seen.has(specifier)) continue
    seen.add(specifier)
    list.push(origin)
  }
  return list.toReversed()
}

async function resolvePathPluginTarget(specifier: string): Promise<string> {
  if (!specifier.startsWith("file://")) throw new Error("Host proof accepts only immutable file plugins")
  const path = fileURLToPath(specifier)
  const details = await stat(path)
  if (!details.isDirectory()) return specifier
  if (await exists(join(path, "package.json"))) return pathToFileURL(path).href
  for (const name of ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]) {
    const candidate = join(path, name)
    if (await exists(candidate)) return pathToFileURL(candidate).href
  }
  throw new Error("OpenCode 1.18.21 plugin directory has no entry")
}

async function createServerPluginEntry(target: string): Promise<string> {
  const path = target.startsWith("file://") ? fileURLToPath(target) : target
  const details = await stat(path)
  if (!details.isDirectory()) return pathToFileURL(path).href
  for (const name of ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]) {
    const candidate = join(path, name)
    if (await exists(candidate)) return pathToFileURL(candidate).href
  }
  throw new Error("OpenCode 1.18.21 server plugin entry is missing")
}

function legacyServerPlugins(module: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const plugins: unknown[] = []
  for (const value of Object.values(module)) {
    if (seen.has(value)) continue
    seen.add(value)
    if (typeof value !== "function") throw new TypeError("Plugin export is not a function")
    plugins.push(value)
  }
  return plugins
}

function assertExactCertificationOptions(
  options: PluginOptions,
  binding: DesktopCertificationBinding,
): void {
  if (
    Object.keys(options).sort().join(",") !== "binaryPath,certification,dataDirectory,hostVersion" ||
    JSON.stringify(options.certification) !== JSON.stringify(binding) ||
    typeof options.binaryPath !== "string" ||
    !isAbsolute(options.binaryPath) ||
    typeof options.dataDirectory !== "string" ||
    !isAbsolute(options.dataDirectory) ||
    options.hostVersion !== "1.18.21"
  ) throw new Error("OpenCode 1.18.21 tuple options are not exactly certification-bound")
}

async function resolveCandidateExport(packageRoot: string): Promise<string> {
  const packageFile = join(packageRoot, "package.json")
  const manifest = JSON.parse(await readFile(packageFile, "utf8")) as { exports?: unknown }
  const exported = isRecord(manifest.exports) ? manifest.exports["."] : undefined
  if (typeof exported !== "string") throw new Error("Packed candidate has no string root export")
  const entry = resolve(packageRoot, exported)
  const rel = relative(packageRoot, entry)
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Packed candidate export escapes its package")
  await access(entry)
  return entry
}

function officialPluginInput(directory: string, worktree: string) {
  const noop = () => undefined
  return {
    client: {
      app: { agents: noop, log: async () => ({}) },
      config: { providers: noop },
      session: {
        abort: noop,
        children: noop,
        create: noop,
        prompt: noop,
        promptAsync: noop,
        status: async () => ({ data: {} }),
      },
    },
    directory,
    serverUrl: new URL("http://127.0.0.1:9"),
    worktree,
  }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function main(): Promise<void> {
  const requestIndex = Bun.argv.indexOf("--request")
  if (requestIndex < 0 || typeof Bun.argv[requestIndex + 1] !== "string") {
    throw new Error("OpenCode 1.18.21 host proof requires --request")
  }
  const request = JSON.parse(await readFile(Bun.argv[requestIndex + 1] as string, "utf8")) as OpenCodeHostProofRequest
  await runOpenCode11821HostProof(request)
  process.exit(0)
}

if (import.meta.main) await main()
