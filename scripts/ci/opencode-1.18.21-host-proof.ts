import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { mock } from "bun:test"

import {
  desktopCertificationBindingDigest,
  type DesktopCertificationBinding,
} from "../../packages/opencode-cycle/src/certification.js"

export const OPENCODE_11821_HOST_PROOF_PROVENANCE = {
  commit: "826d9ad46a22bef0294998e08daa3c4904fea28f",
  files: {
    "packages/core/src/v1/config/plugin.ts": "b45a25d030b253b92449050538433c8ab4dd53db9d2c81228cd6133f4d94837c",
    "packages/opencode/src/config/config.ts": "b0fd57d860661ce70e7fbd06e7f2cc24417c70d3db4207ad97129ac1b649997e",
    "packages/opencode/src/config/paths.ts": "cd86a34461b27caf1042f8cba140fbbed47790c4f30cd9691f87298e8d4d4444",
    "packages/opencode/src/config/plugin.ts": "8c450d5c8fdee1811bb93788462958c7e58ea551c73e18a4173c19917c734f6e",
    "packages/opencode/src/plugin/index.ts": "47c62b7cfae891d268e6b239edb0f1c46df5cb35eb11ccfd8bd4186c156024e9",
    "packages/opencode/src/plugin/loader.ts": "a7eba2d328a36a2486b50245ad98ef0daa769d4109c9e50470d8493b0936c4c0",
    "packages/opencode/src/plugin/shared.ts": "1ada9e15915e47bbb7b16436f0018c9b86845a66e687d89d037be896b9663140",
  },
  license: {
    path: "LICENSE",
    sha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
  },
  normalization: "none",
  repository: "https://github.com/anomalyco/opencode",
  scope: "test-only canonical copies excluded from production archives",
  tag: "v1.18.21",
} as const

export interface OpenCodeHostProofRequest {
  readonly binding: DesktopCertificationBinding
  readonly candidatePackageRoot: string
  readonly configFile: string
  readonly directory: string
  readonly disposeAfterLoad?: boolean
  readonly releaseFile?: string
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

type CanonicalRuntime = {
  ConfigPlugin: {
    deduplicatePluginOrigins(origins: unknown[]): unknown[]
  }
  PluginLoader: {
    loadExternal(input: { items: unknown[]; kind: "server" }): Promise<any[]>
  }
  Schema: {
    decodeUnknownSync(schema: unknown): (value: unknown) => unknown
  }
  Spec: unknown
  applyPlugin(load: unknown, input: unknown, hooks: unknown[]): Promise<void>
  mergeOrigins(steps: Array<{ kind: "global" | "local"; list: unknown[]; source: string }>): Promise<any>
}

const fixtureRoot = fileURLToPath(new URL("./fixtures/opencode-1.18.21/", import.meta.url))

export async function runOpenCode11821HostProof(
  request: OpenCodeHostProofRequest,
): Promise<OpenCodeHostProofReceipt> {
  const scratch = await mkdtemp(join(tmpdir(), "opencode-1.18.21-canonical-"))
  try {
    const runtime = await loadCanonicalRuntime(scratch)
    const config = JSON.parse(await readFile(request.configFile, "utf8")) as { plugin?: unknown }
    if (!Array.isArray(config.plugin) || config.plugin.length !== 1) {
      throw new Error("Canonical OpenCode proof requires one plugin tuple")
    }
    const spec = runtime.Schema.decodeUnknownSync(runtime.Spec)(config.plugin[0])
    if (!Array.isArray(spec)) throw new Error("Canonical OpenCode schema did not preserve tuple options")
    const merged = await runtime.mergeOrigins([
      { kind: "global", list: [spec], source: "global-config" },
      { kind: "local", list: [spec], source: request.configFile },
      { kind: "local", list: [spec], source: dirname(request.configFile) },
    ])
    const origins = merged.plugin_origins as unknown[]
    if (!Array.isArray(origins) || origins.length !== 1) {
      throw new Error("Canonical OpenCode origin merge did not deduplicate the plugin")
    }
    const loaded = await runtime.PluginLoader.loadExternal({ items: origins, kind: "server" })
    if (loaded.length !== 1) throw new Error("Canonical OpenCode PluginLoader did not load one plugin")
    const hooks: Record<string, unknown>[] = []
    await runtime.applyPlugin(loaded[0], officialPluginInput(request.directory, request.worktree), hooks)
    if (hooks.length !== 1) throw new Error("Canonical OpenCode plugin apply did not produce one hook set")
    if (request.disposeAfterLoad && typeof hooks[0]?.dispose === "function") {
      await (hooks[0].dispose as () => Promise<void>)()
    }
    const options = (loaded[0] as { options?: unknown }).options
    assertExactCertificationOptions(options, request.binding)
    const candidateEntry = await resolveCandidateExport(request.candidatePackageRoot)
    const receipt: OpenCodeHostProofReceipt = {
      bindingDigest: desktopCertificationBindingDigest(request.binding),
      candidateEntrySha256: await digest(candidateEntry),
      deduplicatedOrigins: origins.length,
      loadedPlugins: loaded.length,
      mergedOrigins: 3,
      optionsDigest: createHash("sha256").update(JSON.stringify(options)).digest("hex"),
      provenanceCommit: OPENCODE_11821_HOST_PROOF_PROVENANCE.commit,
      tupleOptions: true,
    }
    await writeFile(request.resultFile, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 })
    return receipt
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }
}

async function loadCanonicalRuntime(scratch: string): Promise<CanonicalRuntime> {
  await verifyCanonicalFixture()
  const effectPath = resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
    "node_modules/.bun/effect@4.0.0-beta.83/node_modules/effect/dist/index.js",
  )
  const effect = await import(pathToFileURL(effectPath).href)
  mock.module("effect", () => effect)
  mock.module("@/util/filesystem", () => ({ Filesystem: filesystemBoundary }))
  mock.module("@/util/record", () => ({ isRecord }))
  mock.module("@opencode-ai/core/npm", () => ({ Npm: { add: async () => { throw new Error("network disabled") } } }))
  mock.module("@opencode-ai/core/util/glob", () => ({ Glob: { scan: async () => [] } }))
  mock.module("npm-package-arg", () => ({ default: () => undefined }))
  mock.module("semver", () => ({ default: { major: () => 1, satisfies: () => true, valid: () => true } }))

  const core = await import(fixtureUrl("packages/core/src/v1/config/plugin.ts"))
  mock.module("@opencode-ai/core/v1/config/plugin", () => ({ ConfigPluginV1: core }))
  const shared = await import(fixtureUrl("packages/opencode/src/plugin/shared.ts"))
  mock.module("@/plugin/shared", () => shared)
  const config = await import(fixtureUrl("packages/opencode/src/config/plugin.ts"))
  mock.module("@/config/plugin", () => config)
  mock.module("@opencode-ai/core/installation/version", () => ({ InstallationVersion: "1.18.21" }))
  const loader = await import(fixtureUrl("packages/opencode/src/plugin/loader.ts"))

  const mergeModule = await buildCanonicalMergeModule(scratch, config)
  const applyModule = await buildCanonicalApplyModule(scratch, shared)
  return {
    ConfigPlugin: config.ConfigPlugin,
    PluginLoader: loader.PluginLoader,
    Schema: effect.Schema,
    Spec: core.Spec,
    applyPlugin: applyModule.applyPlugin,
    mergeOrigins: mergeModule.mergeOrigins,
  }
}

async function buildCanonicalMergeModule(scratch: string, ConfigPlugin: unknown) {
  const source = await readFixture("packages/opencode/src/config/config.ts")
  const start = source.indexOf("        const mergePluginOrigins =")
  const end = source.indexOf("        const merge =", start)
  if (start < 0 || end < 0) throw new Error("Canonical config merge extraction boundary drifted")
  const extracted = source.slice(start, end).replace(/^ {8}/gmu, "")
  const path = join(scratch, "canonical-merge.ts")
  const configPluginUrl = pathToFileURL(join(scratch, "config-plugin-bridge.js")).href
  mock.module(configPluginUrl, () => ({ ConfigPlugin }))
  await writeFile(path, `import { Effect } from "effect"\nimport { ConfigPlugin } from ${JSON.stringify(configPluginUrl)}\nlet result = {}\nconst pluginScopeForSource = () => Effect.die("scope must be explicit")\n${extracted}\nexport async function mergeOrigins(steps) {\n  for (const step of steps) await Effect.runPromise(mergePluginOrigins(step.source, step.list, step.kind))\n  return result\n}\n`)
  return import(pathToFileURL(path).href)
}

async function buildCanonicalApplyModule(scratch: string, shared: Record<string, unknown>) {
  const source = await readFixture("packages/opencode/src/plugin/index.ts")
  const start = source.indexOf("function isServerPlugin")
  const end = source.indexOf("const layer =", start)
  if (start < 0 || end < 0) throw new Error("Canonical plugin apply extraction boundary drifted")
  const extracted = source.slice(start, end)
  const path = join(scratch, "canonical-apply.ts")
  const sharedUrl = pathToFileURL(join(scratch, "shared-bridge.js")).href
  mock.module(sharedUrl, () => shared)
  await writeFile(path, `import { readPluginId, readV1Plugin, resolvePluginId } from ${JSON.stringify(sharedUrl)}\ntype PluginInstance = any\ntype PluginInput = any\ntype Hooks = any\ntype PluginModule = any\nnamespace PluginLoader { export type Loaded = any }\n${extracted}\nexport { applyPlugin }\n`)
  return import(pathToFileURL(path).href)
}

export async function verifyCanonicalFixture(): Promise<void> {
  const declared = JSON.parse(await readFile(join(fixtureRoot, "PROVENANCE.json"), "utf8")) as unknown
  if (JSON.stringify(declared) !== JSON.stringify(OPENCODE_11821_HOST_PROOF_PROVENANCE)) {
    throw new Error("Canonical OpenCode fixture provenance drifted")
  }
  const license = await readFile(join(fixtureRoot, OPENCODE_11821_HOST_PROOF_PROVENANCE.license.path))
  if (
    license.includes(0x0d) ||
    (license[0] === 0xef && license[1] === 0xbb && license[2] === 0xbf) ||
    createHash("sha256").update(license).digest("hex") !== OPENCODE_11821_HOST_PROOF_PROVENANCE.license.sha256
  ) throw new Error("Canonical OpenCode fixture license drifted")
  for (const [path, expected] of Object.entries(OPENCODE_11821_HOST_PROOF_PROVENANCE.files)) {
    const bytes = await readFile(join(fixtureRoot, path))
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error("Canonical OpenCode fixture contains a BOM")
    }
    if (bytes.includes(0x0d)) throw new Error("Canonical OpenCode fixture was newline-normalized")
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error("Canonical OpenCode fixture checksum drifted")
    }
  }
}

function fixtureUrl(path: string): string {
  return pathToFileURL(join(fixtureRoot, path)).href
}

function readFixture(path: string): Promise<string> {
  return readFile(join(fixtureRoot, path), "utf8")
}

const filesystemBoundary = {
  resolve,
  contains(root: string, value: string) {
    const rel = relative(resolve(root), resolve(value))
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))
  },
  exists(path: string) { return access(path).then(() => true, () => false) },
  statAsync(path: string) { return import("node:fs/promises").then((fs) => fs.stat(path).catch(() => undefined)) },
  async readJson(path: string) { return JSON.parse(await readFile(path, "utf8")) },
}

function assertExactCertificationOptions(options: unknown, binding: DesktopCertificationBinding): void {
  if (!isRecord(options)) throw new Error("Canonical OpenCode tuple options are missing")
  if (
    Object.keys(options).sort().join(",") !== "binaryPath,certification,dataDirectory,hostVersion" ||
    JSON.stringify(options.certification) !== JSON.stringify(binding) ||
    typeof options.binaryPath !== "string" || !isAbsolute(options.binaryPath) ||
    typeof options.dataDirectory !== "string" || !isAbsolute(options.dataDirectory) ||
    options.hostVersion !== "1.18.21"
  ) throw new Error("Canonical OpenCode tuple options are not certification-bound")
}

async function resolveCandidateExport(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { exports?: unknown }
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
      session: { abort: noop, children: noop, create: noop, prompt: noop, promptAsync: noop, status: async () => ({ data: {} }) },
    },
    directory,
    serverUrl: new URL("http://127.0.0.1:9"),
    worktree,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function digest(path: string): Promise<string> {
  return readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex"))
}

async function main(): Promise<void> {
  const requestIndex = Bun.argv.indexOf("--request")
  if (requestIndex < 0 || typeof Bun.argv[requestIndex + 1] !== "string") {
    throw new Error("Canonical OpenCode host proof requires --request")
  }
  const request = JSON.parse(await readFile(Bun.argv[requestIndex + 1] as string, "utf8")) as OpenCodeHostProofRequest
  await runOpenCode11821HostProof(request)
  if (request.releaseFile !== undefined) {
    const release = resolve(request.releaseFile)
    const contained = relative(request.binding.root, release)
    if (
      !isAbsolute(request.releaseFile) ||
      release !== request.releaseFile ||
      contained === "" ||
      contained === ".." ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    ) throw new Error("Canonical host proof release path is invalid")
    while (!await access(request.releaseFile).then(() => true, () => false)) await Bun.sleep(25)
  }
}

if (import.meta.main) await main()
