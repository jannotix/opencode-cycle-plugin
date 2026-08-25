import { createHash } from "node:crypto"
import type { Dir } from "node:fs"
import {
  lstat,
  mkdir,
  opendir,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  assertNoReparseMaterial,
  readVerifiedFileDirectory,
  type VerifiedFile,
} from "../release/verified-file.js"
import { writeReceiptAtomically } from "./receipt-output.js"

export const OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX =
  "opencode-cycle-official-evidence-"

export const OFFICIAL_RUNTIME_MATERIAL_NAMES = [
  "candidate-entry.js",
  "candidate-wrapper.js",
  "dependency-tree-manifest.json",
  "desktop-runtime-diagnostics.jsonl",
  "desktop-runtime-linker.mjs",
  "desktop-runtime-result.json",
  "runtime-output-summary.json",
  "runtime-receipt.json",
] as const

const EVIDENCE_MANIFEST_NAME = "evidence-manifest.json"
const EXIT_RECEIPT_NAME = "package-gate-exit.json"
const OFFICIAL_RUNTIME_EVIDENCE_NAMES = [
  ...OFFICIAL_RUNTIME_MATERIAL_NAMES,
  EVIDENCE_MANIFEST_NAME,
  EXIT_RECEIPT_NAME,
] as const

type OfficialRuntimeMaterialName = typeof OFFICIAL_RUNTIME_MATERIAL_NAMES[number]

const MATERIAL_LIMITS: Readonly<Record<OfficialRuntimeMaterialName, number>> = {
  "candidate-entry.js": 4 * 1024 * 1024,
  "candidate-wrapper.js": 256 * 1024,
  "dependency-tree-manifest.json": 16 * 1024 * 1024,
  "desktop-runtime-diagnostics.jsonl": 64 * 1024,
  "desktop-runtime-linker.mjs": 2 * 1024 * 1024,
  "desktop-runtime-result.json": 64 * 1024,
  "runtime-output-summary.json": 64 * 1024,
  "runtime-receipt.json": 64 * 1024,
}

export interface OfficialRuntimeEvidenceBinding {
  readonly electronVersion: string
  readonly nativePackageSha256: string
  readonly nodeVersion: string
  readonly pluginPackageSha256: string
  readonly revision: string
  readonly runtimeExecutableSha256: string
  readonly runtimeProductVersion: string
}

export interface OfficialRuntimeEvidencePublication {
  readonly evidenceManifestSha256: string
  readonly exitReceiptSha256: string
  readonly path: string
}

export interface OfficialRuntimeEvidenceSession {
  readonly abort: () => Promise<void>
  readonly path: string
  readonly publish: (input: {
    readonly binding: OfficialRuntimeEvidenceBinding
    readonly material: Readonly<Record<OfficialRuntimeMaterialName, Uint8Array>>
  }) => Promise<OfficialRuntimeEvidencePublication>
}

export async function openOfficialRuntimeEvidenceDirectory(
  requestedPath: string,
): Promise<OfficialRuntimeEvidenceSession> {
  const allowedRoot = resolve(tmpdir())
  const target = resolve(requestedPath)
  if (
    !isAbsolute(requestedPath) || requestedPath !== target || requestedPath.includes("\0") ||
    dirname(target) !== allowedRoot ||
    !basename(target).startsWith(OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX)
  ) throw new Error("Official Electron evidence directory is outside its task-owned temp boundary")
  await assertRealDirectory(allowedRoot)
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing !== undefined) {
    throw new Error("Official Electron evidence directory already exists")
  }
  await mkdir(target, { mode: 0o700, recursive: false })
  let directoryHandle: Dir | undefined
  let published = false
  const closeHandle = async (): Promise<void> => {
    if (directoryHandle === undefined) return
    const handle = directoryHandle
    directoryHandle = undefined
    await handle.close()
  }
  const abort = async (): Promise<void> => {
    if (published) return
    await closeHandle().catch(() => undefined)
    await removeOwnedEvidenceDirectory(target)
  }
  try {
    await assertRealDirectory(target)
    if ((await readdir(target)).length !== 0) {
      throw new Error("Official Electron evidence directory was not created empty")
    }
    directoryHandle = await opendir(target)
    return {
      abort,
      path: target,
      async publish(input) {
        if (published || directoryHandle === undefined) {
          throw new Error("Official Electron evidence session is closed")
        }
        try {
          validateBinding(input.binding)
          validateMaterial(input.material)
          const artifacts: { bytes: number; name: OfficialRuntimeMaterialName; sha256: string }[] = []
          for (const name of OFFICIAL_RUNTIME_MATERIAL_NAMES) {
            const verified = await writeReceiptAtomically(
              { directory: target, path: join(target, name) },
              input.material[name],
            )
            artifacts.push({ bytes: verified.size, name, sha256: verified.sha256 })
          }
          const manifestBytes = jsonLine({
            artifacts,
            nativePackageSha256: input.binding.nativePackageSha256,
            pluginPackageSha256: input.binding.pluginPackageSha256,
            revision: input.binding.revision,
            schemaVersion: 1,
            type: "opencode-cycle-official-electron-evidence-manifest",
          })
          const manifest = await writeReceiptAtomically(
            { directory: target, path: join(target, EVIDENCE_MANIFEST_NAME) },
            manifestBytes,
          )
          const exit = await writeReceiptAtomically(
            { directory: target, path: join(target, EXIT_RECEIPT_NAME) },
            jsonLine({
              electronVersion: input.binding.electronVersion,
              evidenceManifestSha256: manifest.sha256,
              nativePackageSha256: input.binding.nativePackageSha256,
              nodeVersion: input.binding.nodeVersion,
              passed: true,
              pluginPackageSha256: input.binding.pluginPackageSha256,
              revision: input.binding.revision,
              runtimeExecutableSha256: input.binding.runtimeExecutableSha256,
              runtimeProductVersion: input.binding.runtimeProductVersion,
              schemaVersion: 1,
              type: "opencode-cycle-official-electron-package-gate-exit",
            }),
          )
          await validateOfficialRuntimeEvidenceDirectory(target)
          published = true
          await closeHandle()
          return {
            evidenceManifestSha256: manifest.sha256,
            exitReceiptSha256: exit.sha256,
            path: target,
          }
        } catch (error) {
          try {
            await abort()
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Official Electron evidence publication cleanup failed",
            )
          }
          throw error
        }
      },
    }
  } catch (error) {
    await abort().catch(() => undefined)
    throw error
  }
}

export async function validateOfficialRuntimeEvidenceDirectory(path: string): Promise<void> {
  const files = await readVerifiedFileDirectory(path)
  const expectedNames = [...OFFICIAL_RUNTIME_EVIDENCE_NAMES].sort()
  const actualNames = files.map((file) => file.name).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Official Electron evidence filenames are not the exact current schema")
  }
  const byName = new Map(files.map((file) => [file.name, file]))
  const tree = assertJsonArtifact(byName, "dependency-tree-manifest.json", 1,
    "opencode-cycle-desktop-dependency-tree-manifest", true)
  assertJsonLines(byName.get("desktop-runtime-diagnostics.jsonl"))
  const result = assertJsonArtifact(byName, "desktop-runtime-result.json", 2,
    "opencode-cycle-desktop-module-link")
  const output = assertJsonArtifact(byName, "runtime-output-summary.json", 1,
    "opencode-cycle-official-electron-runtime-output")
  const runtime = assertJsonArtifact(byName, "runtime-receipt.json", 4,
    "opencode-cycle-desktop-runtime-guard")
  const manifest = assertJsonArtifact(
    byName,
    EVIDENCE_MANIFEST_NAME,
    1,
    "opencode-cycle-official-electron-evidence-manifest",
  )
  const exit = assertJsonArtifact(
    byName,
    EXIT_RECEIPT_NAME,
    1,
    "opencode-cycle-official-electron-package-gate-exit",
  )
  const artifactRecords = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  if (artifactRecords.length !== OFFICIAL_RUNTIME_MATERIAL_NAMES.length) {
    throw new Error("Official Electron evidence manifest is incomplete")
  }
  for (const name of OFFICIAL_RUNTIME_MATERIAL_NAMES) {
    const file = byName.get(name)
    const record = artifactRecords.find((value) => isRecord(value) && value.name === name)
    if (
      file === undefined || !isRecord(record) || record.bytes !== file.size ||
      record.sha256 !== file.sha256
    ) throw new Error("Official Electron evidence manifest digest is invalid")
  }
  const manifestFile = byName.get(EVIDENCE_MANIFEST_NAME)
  if (
    manifestFile === undefined || exit.evidenceManifestSha256 !== manifestFile.sha256 ||
    exit.passed !== true
  ) throw new Error("Official Electron package-gate exit receipt is invalid")
  const candidate = byName.get("candidate-entry.js")
  const linker = byName.get("desktop-runtime-linker.mjs")
  const loader = byName.get("candidate-wrapper.js")
  const dependencyTree = isRecord(tree.dependencyTree) ? tree.dependencyTree : undefined
  if (
    candidate === undefined || linker === undefined || loader === undefined ||
    !isRecord(dependencyTree) ||
    runtime.candidateEntrySha256 !== candidate.sha256 ||
    runtime.linkerSha256 !== linker.sha256 ||
    runtime.loaderSha256 !== loader.sha256 ||
    runtime.dependencyTreeSha256 !== dependencyTree.dependencyTreeSha256 ||
    runtime.verifiedContentTreeSha256 !== tree.contentTreeSha256 ||
    result.candidateEntrySha256 !== runtime.candidateEntrySha256 ||
    result.dependencyTreeSha256 !== runtime.dependencyTreeSha256 ||
    result.graphFileCount !== runtime.graphFileCount ||
    result.graphSha256 !== runtime.graphSha256 ||
    result.linkedEsmModuleCount !== runtime.linkedEsmModuleCount ||
    result.verifiedCommonJsModuleCount !== runtime.verifiedCommonJsModuleCount ||
    result.verifiedJsonModuleCount !== runtime.verifiedJsonModuleCount ||
    result.verifiedAssetFileCount !== runtime.verifiedAssetFileCount ||
    result.verifiedContentTreeSha256 !== runtime.verifiedContentTreeSha256 ||
    result.suppressedOptionalRootCount !== runtime.suppressedOptionalRootCount ||
    result.electronVersion !== runtime.electronVersion ||
    result.nodeVersion !== runtime.nodeVersion ||
    result.runtimeExecutableSha256 !== runtime.runtimeExecutableSha256 ||
    result.runtimeProductVersion !== runtime.runtimeProductVersion ||
    manifest.nativePackageSha256 !== runtime.nativePackageSha256 ||
    manifest.pluginPackageSha256 !== runtime.pluginPackageSha256 ||
    manifest.revision !== runtime.revision ||
    exit.nativePackageSha256 !== runtime.nativePackageSha256 ||
    exit.pluginPackageSha256 !== runtime.pluginPackageSha256 ||
    exit.revision !== runtime.revision ||
    exit.electronVersion !== runtime.electronVersion ||
    exit.nodeVersion !== runtime.nodeVersion ||
    exit.runtimeExecutableSha256 !== runtime.runtimeExecutableSha256 ||
    exit.runtimeProductVersion !== runtime.runtimeProductVersion ||
    output.exitCode !== 0 || output.outputExceeded !== false || output.timedOut !== false ||
    output.stderrBytes !== 0 || output.stdoutBytes !== 0
  ) throw new Error("Official Electron evidence cross-binding is invalid")
  for (const value of [manifest, exit]) assertNoSensitiveReceiptValue(value)
}

function validateMaterial(
  material: Readonly<Record<OfficialRuntimeMaterialName, Uint8Array>>,
): void {
  const keys = Object.keys(material).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...OFFICIAL_RUNTIME_MATERIAL_NAMES].sort())) {
    throw new Error("Official Electron evidence material set is incomplete")
  }
  for (const name of OFFICIAL_RUNTIME_MATERIAL_NAMES) {
    const content = material[name]
    if (!(content instanceof Uint8Array) || content.byteLength < 1 ||
      content.byteLength > MATERIAL_LIMITS[name]) {
      throw new Error(`Official Electron evidence material is outside its bound: ${name}`)
    }
  }
}

function validateBinding(binding: OfficialRuntimeEvidenceBinding): void {
  for (const digest of [
    binding.nativePackageSha256,
    binding.pluginPackageSha256,
    binding.runtimeExecutableSha256,
  ]) {
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("Official Electron evidence binding digest is invalid")
    }
  }
  if (
    !/^[0-9a-f]{40}$/u.test(binding.revision) ||
    !/^\d+\.\d+\.\d+$/u.test(binding.electronVersion) ||
    !/^\d+\.\d+\.\d+$/u.test(binding.nodeVersion) ||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(binding.runtimeProductVersion)
  ) throw new Error("Official Electron evidence runtime binding is invalid")
}

function assertJsonArtifact(
  files: ReadonlyMap<string, VerifiedFile>,
  name: string,
  schemaVersion: number,
  type: string,
  allowRelativePaths = false,
): Record<string, unknown> {
  const file = files.get(name)
  if (file === undefined) throw new Error(`Official Electron evidence is missing ${name}`)
  let value: unknown
  try {
    value = JSON.parse(file.content.toString("utf8")) as unknown
  } catch {
    throw new Error(`Official Electron evidence JSON is malformed: ${name}`)
  }
  if (!isRecord(value) || value.schemaVersion !== schemaVersion || value.type !== type) {
    throw new Error(`Official Electron evidence schema is invalid: ${name}`)
  }
  if (!allowRelativePaths) assertNoSensitiveReceiptValue(value)
  return value
}

function assertJsonLines(file: VerifiedFile | undefined): void {
  if (file === undefined) throw new Error("Official Electron runtime diagnostics are missing")
  const lines = file.content.toString("utf8").trim().split("\n")
  if (lines.length < 1) throw new Error("Official Electron runtime diagnostics are empty")
  for (const line of lines) {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      throw new Error("Official Electron runtime diagnostics are malformed")
    }
    if (!isRecord(value) || value.schemaVersion !== 2) {
      throw new Error("Official Electron runtime diagnostic schema is invalid")
    }
    assertNoSensitiveReceiptValue(value)
  }
}

function assertNoSensitiveReceiptValue(value: unknown, key = ""): void {
  if (/nonce|secret|token/iu.test(key)) {
    throw new Error("Official Electron receipt contains a secret-bearing field")
  }
  if (typeof value === "string") {
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("file:")) {
      throw new Error("Official Electron receipt contains a local path")
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveReceiptValue(item)
    return
  }
  if (isRecord(value)) {
    for (const [childKey, item] of Object.entries(value)) {
      assertNoSensitiveReceiptValue(item, childKey)
    }
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error("Official Electron evidence directory is a link, reparse point or alias")
  }
  await assertNoReparseMaterial([path])
}

async function removeOwnedEvidenceDirectory(path: string): Promise<void> {
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (details === undefined) return
  if (details.isSymbolicLink() || !details.isDirectory()) {
    await unlink(path)
    return
  }
  await assertRealDirectory(path)
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      throw new Error("Official Electron evidence cleanup refused an unexpected directory")
    }
    await unlink(join(path, entry.name))
  }
  await rmdir(path)
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
