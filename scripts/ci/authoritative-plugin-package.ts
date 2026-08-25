import { readdir } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"

import { PRODUCT_IDENTITY } from "../product-identity.js"
import { validatePluginListing } from "../packaging/plugin-package.js"
import { inspectTarGz } from "../packaging/tar-archive.js"
import { readVerifiedRegularFile, type VerifiedFile } from "../release/verified-file.js"

const AUTHORITATIVE_PLUGIN_PROVENANCE_TYPE =
  "opencode-cycle-authoritative-plugin-package"
const BUN_VERSION = "1.3.14"

export interface AuthoritativePluginProvenance {
  readonly archiveBytes: number
  readonly archiveName: string
  readonly archiveSha256: string
  readonly buildArch: string
  readonly buildPlatform: string
  readonly bunLockSha256: string
  readonly bunVersion: string
  readonly pluginManifestSha256: string
  readonly revision: string
  readonly schemaVersion: number
  readonly type: string
  readonly workspaceManifestSha256: string
}

export interface AuthoritativePluginExpected {
  readonly archiveBytes: number
  readonly archiveName: string
  readonly archiveSha256: string
  readonly bunLockSha256: string
  readonly pluginManifestSha256: string
  readonly revision: string
  readonly workspaceManifestSha256: string
}

export function authoritativePluginPackageMode(input: {
  readonly archive?: string
  readonly official: boolean
  readonly provenance?: string
}): "authoritative-prebuilt" | "local-repack" {
  if (!input.official) return "local-repack"
  if (input.archive === undefined) {
    throw new Error("Official Desktop guard requires a prebuilt plugin archive")
  }
  if (input.provenance === undefined) {
    throw new Error("Official Desktop guard requires plugin provenance")
  }
  return "authoritative-prebuilt"
}

export function validateAuthoritativePluginProvenance(
  value: unknown,
  expected: AuthoritativePluginExpected,
): asserts value is AuthoritativePluginProvenance {
  if (!isRecord(value)) throw new Error("Authoritative plugin provenance is malformed")
  const exactKeys = [
    "archiveBytes",
    "archiveName",
    "archiveSha256",
    "buildArch",
    "buildPlatform",
    "bunLockSha256",
    "bunVersion",
    "pluginManifestSha256",
    "revision",
    "schemaVersion",
    "type",
    "workspaceManifestSha256",
  ].sort()
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exactKeys)) {
    throw new Error("Authoritative plugin provenance fields are not exact")
  }
  if (
    value.schemaVersion !== 1 || value.type !== AUTHORITATIVE_PLUGIN_PROVENANCE_TYPE ||
    value.buildPlatform !== "linux" || value.buildArch !== "x64" ||
    value.bunVersion !== BUN_VERSION ||
    typeof value.archiveBytes !== "number" || !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes < 1 || typeof value.archiveName !== "string" ||
    !/^opencode-cycle-\d+\.\d+\.\d+\.tgz$/u.test(value.archiveName) ||
    typeof value.revision !== "string" || !/^[0-9a-f]{40}$/u.test(value.revision)
  ) throw new Error("Authoritative plugin provenance identity is invalid")
  for (const name of [
    "archiveSha256",
    "bunLockSha256",
    "pluginManifestSha256",
    "workspaceManifestSha256",
  ] as const) {
    if (typeof value[name] !== "string" || !/^[0-9a-f]{64}$/u.test(value[name])) {
      throw new Error("Authoritative plugin provenance digest is invalid")
    }
  }
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (value[name] !== expectedValue) {
      throw new Error(`Authoritative plugin provenance mismatch: ${name}`)
    }
  }
}

export async function readAuthoritativePluginPackage(input: {
  readonly archive: string
  readonly provenance: string
  readonly revision: string
  readonly root: string
}): Promise<VerifiedFile> {
  for (const [name, value] of [
    ["archive", input.archive],
    ["provenance", input.provenance],
  ] as const) {
    if (!isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
      throw new Error(`Authoritative plugin ${name} path must be canonical and absolute`)
    }
  }
  if (!input.archive.endsWith(".tgz") ||
    input.provenance !== `${input.archive}.provenance.json`) {
    throw new Error("Authoritative plugin provenance path does not bind the archive name")
  }
  if (!/^[0-9a-f]{40}$/u.test(input.revision)) {
    throw new Error("Authoritative plugin revision is invalid")
  }
  const root = resolve(input.root)
  const packageRoot = join(root, "packages", PRODUCT_IDENTITY.mainPackage)
  const [archive, provenance, lock, workspaceManifest, pluginManifest] = await Promise.all([
    readVerifiedRegularFile(input.archive, { maxBytes: 128 * 1024 * 1024 }),
    readVerifiedRegularFile(input.provenance, { maxBytes: 64 * 1024 }),
    readVerifiedRegularFile(join(root, "bun.lock"), { maxBytes: 16 * 1024 * 1024, root }),
    readVerifiedRegularFile(join(root, "package.json"), { maxBytes: 1024 * 1024, root }),
    readVerifiedRegularFile(join(packageRoot, "package.json"), {
      maxBytes: 1024 * 1024,
      root: packageRoot,
    }),
  ])
  let provenanceValue: unknown
  try {
    provenanceValue = JSON.parse(provenance.content.toString("utf8")) as unknown
  } catch {
    throw new Error("Authoritative plugin provenance JSON is malformed")
  }
  validateAuthoritativePluginProvenance(provenanceValue, {
    archiveBytes: archive.size,
    archiveName: archive.name,
    archiveSha256: archive.sha256,
    bunLockSha256: lock.sha256,
    pluginManifestSha256: pluginManifest.sha256,
    revision: input.revision,
    workspaceManifestSha256: workspaceManifest.sha256,
  })
  const sourceModules = (await readdir(join(packageRoot, "src"), { recursive: true }))
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => path.replace(/\.ts$/u, ".js"))
  const entries = inspectTarGz(archive.content)
  validatePluginListing(
    entries.map((entry) => entry.name),
    sourceModules,
    ["browser/managed-browser-worker.mjs"],
  )
  const packedManifest = entries.find((entry) => entry.name === "package/package.json")
  if (packedManifest === undefined ||
    canonicalJson(packedManifest.content) !== canonicalJson(pluginManifest.content)) {
    throw new Error("Authoritative plugin package manifest does not match the source manifest")
  }
  return archive
}

function canonicalJson(content: Uint8Array): string {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown
  } catch {
    throw new Error("Authoritative plugin package manifest JSON is malformed")
  }
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
