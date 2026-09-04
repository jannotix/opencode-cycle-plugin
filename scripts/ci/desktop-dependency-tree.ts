import { createHash } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import {
  access,
  lstat,
  open,
  opendir,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises"
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"

import { assertNoReparseMaterial, assertStableOpenFile } from "../release/verified-file.js"

// Reading and hashing every dependency file is the dominant cost of a membership
// capture, and the walk runs three times per verification. One strictly serial
// open-stat-read-stat chain per file is per-file latency rather than throughput,
// so the reads run through a bounded pool. The bound stays small enough to keep
// the open handle count and resident content well inside the tree bounds below.
const DEPENDENCY_READ_CONCURRENCY = 32
const MAX_DEPENDENCY_FILES = 50_000
const MAX_DEPENDENCY_FILE_BYTES = 64 * 1024 * 1024
const MAX_DEPENDENCY_TREE_BYTES = 512 * 1024 * 1024
const MAX_RUNTIME_INPUT_BYTES = 64 * 1024 * 1024
const MAX_RUNTIME_INPUT_FILES = 10_000
export const DESKTOP_LINKER_INPUT_MAGIC = "OPENCODE_CYCLE_GRAPH_V2\0"
const LINKER_INPUT_FRAME_BYTES = 53

export interface DesktopDependencyTreeReceipt {
  readonly dependencyFileCount: number
  readonly dependencyPackageCount: number
  readonly dependencyTotalBytes: number
  readonly dependencyTreeSha256: string
  readonly schemaVersion: 1
}

export interface DesktopDependencyTreeVerification {
  readonly abort: () => Promise<void>
  readonly contentManifest: readonly DesktopDependencyContentFile[]
  readonly contentTreeSha256: string
  readonly openLinkerInput: () => DesktopDependencyLinkerInput
  readonly receipt: DesktopDependencyTreeReceipt
  readonly verifyAndClose: () => Promise<DesktopDependencyTreeReceipt>
}

export interface DesktopDependencyContentFile {
  readonly identity: DesktopDependencyFileIdentity
  readonly path: string
  readonly sha256: string
}

export interface DesktopDependencyFileIdentity {
  readonly changedNanoseconds: string
  readonly device: string
  readonly inode: string
  readonly linkCount: string
  readonly mode: string
  readonly modifiedNanoseconds: string
  readonly size: string
}

export interface DesktopDependencyTreeManifest {
  readonly contentTreeSha256: string
  readonly dependencyTree: DesktopDependencyTreeReceipt
  readonly files: readonly DesktopDependencyContentFile[]
  readonly schemaVersion: 2
  readonly type: "opencode-cycle-desktop-dependency-tree-manifest"
}

export interface DesktopDependencyLinkerInput {
  readonly close: () => Promise<void>
  readonly contentTreeSha256: string
  readonly createReadStream: () => NodeJS.ReadableStream
  readonly fullTreeFileCount: number
  readonly fullTreeSerializedBytes: number
  readonly preparationDurationMillis: number
  readonly runtimeInputContentBytes: number
  readonly runtimeInputFileCount: number
  readonly runtimeInputSerializedBytes: number
  readonly runtimeInputSha256: string
}

interface MembershipFileResult {
  readonly contentRecord: string
  readonly entry?: HeldDependencyFile
  readonly record: string
}

/**
 * Runs the reads through a bounded pool. A failing read must not leave the
 * successful ones open: every worker is allowed to finish, then any handle a
 * completed slot is holding is closed before the first failure is rethrown,
 * because a caller that never receives the snapshot never receives the handles
 * either and has nothing left to close them with.
 */
async function readAllSlots(
  reads: readonly (() => Promise<void>)[],
  slots: readonly (MembershipFileResult | undefined)[],
): Promise<void> {
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(DEPENDENCY_READ_CONCURRENCY, reads.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= reads.length) return
        await reads[index]!()
      }
    }),
  )
  const failure = results.find((result) => result.status === "rejected")
  if (failure === undefined) return
  await Promise.allSettled(
    slots.map((slot) => slot?.entry?.handle.close() ?? Promise.resolve()),
  )
  throw (failure as PromiseRejectedResult).reason
}

interface HeldDependencyFile {
  readonly content: Buffer
  readonly handle: FileHandle
  readonly identity: DesktopDependencyFileIdentity
  readonly metadata: string
  readonly path: string
  readonly relativePath: string
  readonly sha256: string
}

interface RuntimeInputFile {
  readonly file: HeldDependencyFile
  readonly kind: "content" | "metadata"
}

interface DependencyMembershipSnapshot {
  readonly canonical: string
  readonly contentTreeSha256: string
  readonly fileCount: number
  readonly paths: readonly string[]
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly name?: string
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly version?: string
}

interface DependencyFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

export async function verifyDesktopDependencyTree(
  installedPlugin: string,
): Promise<DesktopDependencyTreeReceipt> {
  const root = resolve(installedPlugin)
  const rootDetails = await lstat(root)
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Desktop dependency root must be a real contained directory")
  }
  await rejectAncestorDependencyRoots(root)

  const candidateManifest = await readManifest(join(root, "package.json"), root)
  const visitedPackages = new Set<string>()
  for (const name of Object.keys(candidateManifest.dependencies ?? {}).sort()) {
    await visitPackage(name, root, root, false, visitedPackages)
  }
  for (const name of Object.keys(candidateManifest.optionalDependencies ?? {}).sort()) {
    await visitPackage(name, root, root, true, visitedPackages)
  }
  for (const name of Object.keys(candidateManifest.peerDependencies ?? {}).sort()) {
    const optional = candidateManifest.peerDependenciesMeta?.[name]?.optional === true
    await visitPackage(name, root, root, optional, visitedPackages)
  }

  const dependencyRoot = join(root, "node_modules")
  const files = await access(dependencyRoot).then(
    () => collectDependencyFiles(dependencyRoot, root),
    () => Promise.resolve([] as DependencyFile[]),
  )
  const verifiedPaths = [root, ...(await access(dependencyRoot).then(() => [dependencyRoot], () => []))]
  for (const file of files) verifiedPaths.push(file.path)
  for (let index = 0; index < verifiedPaths.length; index += 512) {
    await assertNoReparseMaterial(verifiedPaths.slice(index, index + 512))
  }
  const dependencyTotalBytes = files.reduce((total, file) => total + file.size, 0)
  if (dependencyTotalBytes > MAX_DEPENDENCY_TREE_BYTES) {
    throw new Error("Desktop dependency tree exceeds its byte limit")
  }
  const canonical = files
    .map((file) => {
      const path = containedRelativePath(root, file.path)
      return `${path}\0${file.size}\0${file.sha256}\n`
    })
    .sort()
    .join("")
  return {
    dependencyFileCount: files.length,
    dependencyPackageCount: visitedPackages.size,
    dependencyTotalBytes,
    dependencyTreeSha256: createHash("sha256").update(canonical).digest("hex"),
    schemaVersion: 1,
  }
}

export async function openDesktopDependencyTreeVerification(
  installedPlugin: string,
): Promise<DesktopDependencyTreeVerification> {
  const root = resolve(installedPlugin)
  const rootHandle = await opendir(root)
  const held: HeldDependencyFile[] = []
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await Promise.allSettled([
      ...held.map((file) => file.handle.close()),
      rootHandle.close(),
    ])
  }
  try {
    const initial = await captureDependencyMembership(root, held)
    const receipt = await verifyDesktopDependencyTree(root)
    const stable = await captureDependencyMembership(root)
    if (stable.canonical !== initial.canonical) {
      throw new Error("Desktop dependency tree changed while verified handles were opened")
    }
    return {
      abort: close,
      contentManifest: [...held]
        .map((file) => ({
          identity: file.identity,
          path: file.relativePath,
          sha256: file.sha256,
        }))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
      contentTreeSha256: initial.contentTreeSha256,
      openLinkerInput() {
        if (closed) throw new Error("Desktop dependency verification handles are closed")
        const preparationStartedAt = Date.now()
        const fullTreeFiles = [...held].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath))
        const files = selectRuntimeInputFiles(fullTreeFiles)
        const runtimeInputContentBytes = files.reduce((total, input) =>
          total + (input.kind === "content" ? input.file.content.byteLength : 0), 0)
        const runtimeInputSha256 = runtimeInputDigest(files)
        const runtimeInputSerializedBytes = DESKTOP_LINKER_INPUT_MAGIC.length + 4 +
          files.reduce((total, input) => total + LINKER_INPUT_FRAME_BYTES +
            Buffer.byteLength(input.file.relativePath) +
            (input.kind === "content" ? input.file.content.byteLength : 0), 0)
        if (
          files.length > MAX_RUNTIME_INPUT_FILES ||
          runtimeInputSerializedBytes > MAX_RUNTIME_INPUT_BYTES
        ) throw new Error("Desktop runtime input exceeds its serialized bound")
        const fullTreeSerializedBytes = DESKTOP_LINKER_INPUT_MAGIC.length + 4 +
          fullTreeFiles.reduce((total, file) =>
            total + 12 + Buffer.byteLength(file.relativePath) + file.content.byteLength, 0)
        let inputClosed = false
        let streamOpened = false
        return {
          async close() { inputClosed = true },
          contentTreeSha256: initial.contentTreeSha256,
          createReadStream() {
            if (inputClosed || closed) throw new Error("Desktop linker input handle is closed")
            if (streamOpened) throw new Error("Desktop linker input stream is single-use")
            streamOpened = true
            const frames = function* (): Generator<Buffer> {
              const header = Buffer.alloc(4)
              header.writeUInt32LE(files.length)
              yield Buffer.from(DESKTOP_LINKER_INPUT_MAGIC, "utf8")
              yield header
              for (const input of files) {
                const file = input.file
                const name = Buffer.from(file.relativePath, "utf8")
                const contentBytes = input.kind === "content" ? file.content.byteLength : 0
                const frame = Buffer.alloc(LINKER_INPUT_FRAME_BYTES)
                frame.writeUInt8(input.kind === "content" ? 1 : 2, 0)
                frame.writeUInt32LE(name.byteLength, 1)
                frame.writeBigUInt64LE(BigInt(file.content.byteLength), 5)
                frame.writeBigUInt64LE(BigInt(contentBytes), 13)
                Buffer.from(file.sha256, "hex").copy(frame, 21)
                yield frame
                yield name
                if (input.kind === "content") yield file.content
              }
            }
            return Readable.from(frames())
          },
          fullTreeFileCount: fullTreeFiles.length,
          fullTreeSerializedBytes,
          preparationDurationMillis: Date.now() - preparationStartedAt,
          runtimeInputContentBytes,
          runtimeInputFileCount: files.length,
          runtimeInputSerializedBytes,
          runtimeInputSha256,
        }
      },
      receipt,
      async verifyAndClose() {
        if (closed) throw new Error("Desktop dependency verification handles are closed")
        try {
          for (const file of held) {
            const current = await file.handle.stat({ bigint: true })
            if (membershipMetadata(current) !== file.metadata) {
              throw new Error("Desktop dependency file changed while its verified handle was open")
            }
          }
          const [current, currentReceipt] = await Promise.all([
            captureDependencyMembership(root),
            verifyDesktopDependencyTree(root),
          ])
          if (
            current.canonical !== initial.canonical ||
            current.contentTreeSha256 !== initial.contentTreeSha256 ||
            current.fileCount !== initial.fileCount ||
            JSON.stringify(currentReceipt) !== JSON.stringify(receipt)
          ) throw new Error("Desktop dependency tree changed during module link proof")
          await close()
          return currentReceipt
        } catch (error) {
          await close()
          throw error
        }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function captureDependencyMembership(
  root: string,
  held?: HeldDependencyFile[],
): Promise<DependencyMembershipSnapshot> {
  const records: string[] = []
  const contentRecords: string[] = []
  const paths: string[] = []
  const slots: (MembershipFileResult | undefined)[] = []
  const reads: (() => Promise<void>)[] = []
  let files = 0
  let totalBytes = 0
  const visit = async (path: string): Promise<void> => {
    const details = await lstat(path, { bigint: true })
    const resolved = resolve(path)
    const real = await realpath(path)
    if (
      details.isSymbolicLink() || real !== resolved || !inside(resolved, root) ||
      (!details.isDirectory() && (!details.isFile() || details.nlink !== 1n))
    ) throw new Error("Desktop dependency membership contains a link, alias or non-private file")
    paths.push(path)
    const name = resolved === root ? "." : containedRelativePath(root, resolved)
    if (details.isDirectory()) {
      records.push(`${name}\0directory\0${membershipMetadata(details)}\n`)
      const entries = await readdir(path, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) await visit(join(path, entry.name))
      return
    }
    files += 1
    totalBytes += Number(details.size)
    if (
      files > MAX_DEPENDENCY_FILES || details.size > BigInt(MAX_DEPENDENCY_FILE_BYTES) ||
      totalBytes > MAX_DEPENDENCY_TREE_BYTES
    ) throw new Error("Desktop dependency membership exceeds its bound")
    // The slot is claimed in discovery order and filled by whichever worker runs
    // the read, so concurrency never reaches the records, the content tree or the
    // held handles: they are assembled below in exactly the order a serial walk
    // produced, and every digest keeps the value it had.
    const slot = slots.length
    slots.push(undefined)
    reads.push(() => readSlot(path, name, details, slot))
  }

  const readSlot = async (
    path: string,
    name: string,
    details: BigIntStats,
    slot: number,
  ): Promise<void> => {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
    const handle = await open(path, constants.O_RDONLY | noFollow)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new Error("Desktop dependency membership file is not private")
      }
      const content = await handle.readFile()
      const after = await handle.stat({ bigint: true })
      assertStableOpenFile(before, after)
      if (membershipMetadata(after) !== membershipMetadata(details)) {
        throw new Error("Desktop dependency membership file changed identity")
      }
      const identity = normalizeDesktopDependencyFileIdentity(after)
      const metadata = identityMetadata(identity)
      const sha256 = createHash("sha256").update(content).digest("hex")
      slots[slot] = {
        contentRecord: `${name}\0${content.byteLength}\0${sha256}\n`,
        record: `${name}\0file\0${metadata}\0${sha256}\n`,
        ...(held === undefined
          ? {}
          : { entry: { content, handle, identity, metadata, path, relativePath: name, sha256 } }),
      }
      if (held === undefined) await handle.close()
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  await visit(root)
  await readAllSlots(reads, slots)
  for (const result of slots) {
    if (result === undefined) throw new Error("Desktop dependency membership left a file unread")
    records.push(result.record)
    contentRecords.push(result.contentRecord)
    if (result.entry !== undefined) held?.push(result.entry)
  }
  for (let index = 0; index < paths.length; index += 512) {
    await assertNoReparseMaterial(paths.slice(index, index + 512))
  }
  return {
    canonical: records.sort().join(""),
    contentTreeSha256: createHash("sha256").update(contentRecords.sort().join("")).digest("hex"),
    fileCount: files,
    paths,
  }
}

function selectRuntimeInputFiles(files: readonly HeldDependencyFile[]): RuntimeInputFile[] {
  const byPath = new Map(files.map((file) => [file.relativePath, file]))
  const selected = new Map<string, RuntimeInputFile>()
  for (const file of files) {
    if (runtimeContentFile(file.relativePath)) {
      selected.set(file.relativePath, { file, kind: "content" })
    }
  }
  for (const manifestFile of files.filter((file) => posix.basename(file.relativePath) === "package.json")) {
    let manifest: unknown
    try {
      manifest = JSON.parse(manifestFile.content.toString("utf8")) as unknown
    } catch {
      throw new Error("Desktop runtime input package manifest is malformed")
    }
    if (!isRecord(manifest)) throw new Error("Desktop runtime input package manifest is malformed")
    const packageDirectory = posix.dirname(manifestFile.relativePath)
    for (const target of manifestRuntimeTargets(manifest)) {
      if (!target.startsWith("./")) continue
      const relativeTarget = posix.normalize(posix.join(packageDirectory, target))
      if (
        relativeTarget === ".." || relativeTarget.startsWith("../") ||
        posix.isAbsolute(relativeTarget)
      ) throw new Error("Desktop runtime input manifest target escapes its package")
      if (!relativeTarget.includes("*")) {
        const file = byPath.get(relativeTarget)
        if (file !== undefined && !runtimeContentFile(file.relativePath)) {
          selected.set(file.relativePath, { file, kind: "metadata" })
        }
        continue
      }
      const [prefix = "", suffix = ""] = relativeTarget.split("*")
      for (const file of files) {
        if (
          file.relativePath.startsWith(prefix) && file.relativePath.endsWith(suffix) &&
          !runtimeContentFile(file.relativePath)
        ) selected.set(file.relativePath, { file, kind: "metadata" })
      }
    }
  }
  for (const source of files.filter((file) => [".cjs", ".js", ".mjs"]
    .includes(extname(file.relativePath).toLowerCase()))) {
    const expression = /\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(\s*(["'])([^"']+)\1\s*\)/gu
    for (const match of source.content.toString("utf8").matchAll(expression)) {
      const specifier = match[2]
      if (specifier === undefined) continue
      const target = resolveLiteralAssetTarget(source.relativePath, specifier, byPath)
      if (target !== undefined && !runtimeContentFile(target.relativePath)) {
        selected.set(target.relativePath, { file: target, kind: "metadata" })
      }
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.file.relativePath.localeCompare(right.file.relativePath))
}

function resolveLiteralAssetTarget(
  parent: string,
  specifier: string,
  files: ReadonlyMap<string, HeldDependencyFile>,
): HeldDependencyFile | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = posix.normalize(posix.join(posix.dirname(parent), specifier))
    if (target === ".." || target.startsWith("../") || posix.isAbsolute(target)) return undefined
    return files.get(target)
  }
  if (
    specifier.startsWith("#") || specifier.startsWith("/") || specifier.startsWith("file:") ||
    specifier.includes("\\") || specifier.includes("\0")
  ) return undefined
  const segments = specifier.split("/")
  const packageName = specifier.startsWith("@")
    ? segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined
    : segments[0]
  if (packageName === undefined) return undefined
  const consumed = packageName.startsWith("@") ? 2 : 1
  if (segments.length === consumed) return undefined
  let cursor = posix.dirname(parent)
  for (;;) {
    const packageRoot = posix.join(cursor === "." ? "" : cursor, "node_modules", packageName)
    if (files.has(posix.join(packageRoot, "package.json"))) {
      return files.get(posix.join(packageRoot, ...segments.slice(consumed)))
    }
    if (cursor === ".") return undefined
    cursor = posix.dirname(cursor)
  }
}

function runtimeContentFile(path: string): boolean {
  return [".cjs", ".js", ".json", ".mjs"].includes(extname(path).toLowerCase())
}

function manifestRuntimeTargets(manifest: Readonly<Record<string, unknown>>): string[] {
  const targets: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      targets.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (isRecord(value)) for (const item of Object.values(value)) collect(item)
  }
  collect(manifest.exports)
  collect(manifest.imports)
  collect(manifest.main)
  return targets
}

function runtimeInputDigest(files: readonly RuntimeInputFile[]): string {
  const canonical = files.map(({ file, kind }) =>
    `${file.relativePath}\0${kind}\0${file.content.byteLength}\0${file.sha256}\n`).sort().join("")
  return createHash("sha256").update(canonical).digest("hex")
}

export function normalizeDesktopDependencyFileIdentity(
  value: unknown,
): DesktopDependencyFileIdentity {
  if (!isRecord(value)) throw new Error("Desktop dependency file identity is invalid")
  const identity = {
    changedNanoseconds: nanoseconds(value.ctimeNs, value.ctimeMs),
    device: decimalInteger(value.dev),
    inode: decimalInteger(value.ino),
    linkCount: decimalInteger(value.nlink),
    mode: decimalInteger(value.mode),
    modifiedNanoseconds: nanoseconds(value.mtimeNs, value.mtimeMs),
    size: decimalInteger(value.size),
  }
  validateDesktopDependencyFileIdentity(identity, false)
  return identity
}

export function desktopDependencyContentTreeSha256(
  files: readonly DesktopDependencyContentFile[],
): string {
  const normalized = normalizeContentManifest(files)
  const canonical = normalized.map((file) =>
    `${file.path}\0${file.identity.size}\0${file.sha256}\n`).sort().join("")
  return createHash("sha256").update(canonical).digest("hex")
}

export function serializeDesktopDependencyTreeManifest(input: {
  readonly contentTreeSha256: string
  readonly dependencyTree: DesktopDependencyTreeReceipt
  readonly files: readonly DesktopDependencyContentFile[]
}): Buffer {
  const manifest = normalizedDependencyTreeManifest({
    ...input,
    schemaVersion: 2,
    type: "opencode-cycle-desktop-dependency-tree-manifest",
  })
  return Buffer.from(`${JSON.stringify(manifest)}\n`)
}

export function parseDesktopDependencyTreeManifest(
  content: Uint8Array,
): DesktopDependencyTreeManifest {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown
  } catch {
    throw new Error("Desktop dependency tree manifest JSON is malformed")
  }
  return normalizedDependencyTreeManifest(value)
}

function normalizedDependencyTreeManifest(value: unknown): DesktopDependencyTreeManifest {
  if (!isRecord(value)) throw new Error("Desktop dependency tree manifest is invalid")
  assertExactKeys(value, ["contentTreeSha256", "dependencyTree", "files", "schemaVersion", "type"])
  if (
    value.schemaVersion !== 2 || value.type !== "opencode-cycle-desktop-dependency-tree-manifest" ||
    typeof value.contentTreeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.contentTreeSha256) || !Array.isArray(value.files)
  ) throw new Error("Desktop dependency tree manifest schema is invalid")
  const files = normalizeContentManifest(value.files)
  const dependencyTree = normalizeDependencyTreeReceipt(value.dependencyTree)
  if (desktopDependencyContentTreeSha256(files) !== value.contentTreeSha256) {
    throw new Error("Desktop dependency tree manifest content digest is invalid")
  }
  return {
    contentTreeSha256: value.contentTreeSha256,
    dependencyTree,
    files,
    schemaVersion: 2,
    type: "opencode-cycle-desktop-dependency-tree-manifest",
  }
}

function normalizeContentManifest(value: readonly unknown[]): DesktopDependencyContentFile[] {
  if (value.length < 1 || value.length > MAX_DEPENDENCY_FILES) {
    throw new Error("Desktop dependency content manifest file count is invalid")
  }
  const files = value.map((item) => {
    if (!isRecord(item)) throw new Error("Desktop dependency content manifest entry is invalid")
    assertExactKeys(item, ["identity", "path", "sha256"])
    if (
      typeof item.path !== "string" || item.path.includes("\\") || item.path.includes("\0") ||
      item.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(item.sha256)
    ) throw new Error("Desktop dependency content manifest entry is invalid")
    const identity = normalizedIdentityRecord(item.identity)
    return { identity, path: item.path, sha256: item.sha256 }
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  if (files.some((file, index) => index > 0 && files[index - 1]?.path === file.path)) {
    throw new Error("Desktop dependency content manifest contains a duplicate path")
  }
  return files
}

function normalizedIdentityRecord(value: unknown): DesktopDependencyFileIdentity {
  if (!isRecord(value)) throw new Error("Desktop dependency content identity is invalid")
  assertExactKeys(value, [
    "changedNanoseconds",
    "device",
    "inode",
    "linkCount",
    "mode",
    "modifiedNanoseconds",
    "size",
  ])
  const identity = {
    changedNanoseconds: decimalString(value.changedNanoseconds),
    device: decimalString(value.device),
    inode: decimalString(value.inode),
    linkCount: decimalString(value.linkCount),
    mode: decimalString(value.mode),
    modifiedNanoseconds: decimalString(value.modifiedNanoseconds),
    size: decimalString(value.size),
  }
  validateDesktopDependencyFileIdentity(identity)
  return identity
}

function validateDesktopDependencyFileIdentity(
  identity: DesktopDependencyFileIdentity,
  requirePrivate = true,
): void {
  if (
    (requirePrivate && identity.linkCount !== "1") ||
    BigInt(identity.size) > BigInt(MAX_DEPENDENCY_FILE_BYTES)
  ) throw new Error("Desktop dependency file identity is outside its bound")
}

function normalizeDependencyTreeReceipt(value: unknown): DesktopDependencyTreeReceipt {
  if (!isRecord(value)) throw new Error("Desktop dependency tree receipt is invalid")
  assertExactKeys(value, [
    "dependencyFileCount",
    "dependencyPackageCount",
    "dependencyTotalBytes",
    "dependencyTreeSha256",
    "schemaVersion",
  ])
  if (
    value.schemaVersion !== 1 || typeof value.dependencyFileCount !== "number" ||
    !Number.isSafeInteger(value.dependencyFileCount) || value.dependencyFileCount < 0 ||
    typeof value.dependencyPackageCount !== "number" ||
    !Number.isSafeInteger(value.dependencyPackageCount) || value.dependencyPackageCount < 0 ||
    typeof value.dependencyTotalBytes !== "number" ||
    !Number.isSafeInteger(value.dependencyTotalBytes) || value.dependencyTotalBytes < 0 ||
    typeof value.dependencyTreeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.dependencyTreeSha256)
  ) throw new Error("Desktop dependency tree receipt is invalid")
  return value as unknown as DesktopDependencyTreeReceipt
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error("Desktop dependency manifest has missing or unknown fields")
  }
}

function decimalInteger(value: unknown): string {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error("Desktop dependency identity integer is negative")
    return value.toString(10)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Desktop dependency identity number is unsafe")
    }
    return String(value)
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) return value
  throw new Error("Desktop dependency identity decimal is malformed")
}

function decimalString(value: unknown): string {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) return value
  throw new Error("Desktop dependency identity decimal is malformed")
}

function nanoseconds(nanosecondValue: unknown, millisecondValue: unknown): string {
  if (nanosecondValue !== undefined) return decimalInteger(nanosecondValue)
  if (typeof millisecondValue === "bigint") return (millisecondValue * 1_000_000n).toString(10)
  if (
    typeof millisecondValue !== "number" || !Number.isFinite(millisecondValue) ||
    millisecondValue < 0 || !Number.isSafeInteger(Math.trunc(millisecondValue))
  ) throw new Error("Desktop dependency identity timestamp is unsafe")
  const whole = Math.trunc(millisecondValue)
  const fraction = Math.round((millisecondValue - whole) * 1_000_000)
  return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString(10)
}

function identityMetadata(identity: DesktopDependencyFileIdentity): string {
  return [
    identity.device,
    identity.inode,
    identity.size,
    identity.modifiedNanoseconds,
    identity.changedNanoseconds,
    identity.linkCount,
    identity.mode,
  ].join("\0")
}

function membershipMetadata(details: Awaited<ReturnType<typeof lstat>>): string {
  return identityMetadata(normalizeDesktopDependencyFileIdentity(details))
}

async function rejectAncestorDependencyRoots(root: string): Promise<void> {
  let cursor = dirname(root)
  for (;;) {
    if (await access(join(cursor, "node_modules")).then(() => true, () => false)) {
      throw new Error("Desktop dependency resolution must remain contained in the installed plugin")
    }
    const parent = dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

async function visitPackage(
  name: string,
  from: string,
  root: string,
  optional: boolean,
  visited: Set<string>,
): Promise<void> {
  const metadata = await resolveContainedPackage(name, from, root)
  if (metadata === undefined) {
    if (optional) return
    throw new Error("Desktop dependency resolution is not contained in the installed plugin")
  }
  const realMetadata = await realpath(metadata)
  if (!inside(realMetadata, root)) {
    throw new Error("Desktop dependency metadata escapes the installed plugin")
  }
  if (visited.has(realMetadata)) return
  const manifest = await readManifest(realMetadata, root)
  if (manifest.name !== name || typeof manifest.version !== "string") {
    throw new Error("Desktop dependency package metadata is invalid")
  }
  visited.add(realMetadata)
  const packageRoot = dirname(realMetadata)
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    await visitPackage(dependency, packageRoot, root, false, visited)
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
    await visitPackage(dependency, packageRoot, root, true, visited)
  }
  for (const dependency of Object.keys(manifest.peerDependencies ?? {}).sort()) {
    const peerOptional = manifest.peerDependenciesMeta?.[dependency]?.optional === true
    await visitPackage(dependency, packageRoot, root, peerOptional, visited)
  }
}

async function resolveContainedPackage(
  name: string,
  from: string,
  root: string,
): Promise<string | undefined> {
  let cursor = resolve(from)
  const segments = name.split("/")
  for (;;) {
    const candidate = join(cursor, "node_modules", ...segments, "package.json")
    if (await access(candidate).then(() => true, () => false)) return candidate
    if (cursor === root) return undefined
    const parent = dirname(cursor)
    if (!inside(parent, root)) return undefined
    cursor = parent
  }
}

async function readManifest(path: string, root: string): Promise<PackageManifest> {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error("Desktop dependency package metadata is not a regular private file")
  }
  if (!inside(await realpath(path), root)) {
    throw new Error("Desktop dependency package metadata escapes the installed plugin")
  }
  let value: unknown
  try {
    value = JSON.parse(await Bun.file(path).text()) as unknown
  } catch {
    throw new Error("Desktop dependency package metadata is malformed")
  }
  if (!isRecord(value)) throw new Error("Desktop dependency package metadata is malformed")
  return value as PackageManifest
}

async function collectDependencyFiles(
  directory: string,
  root: string,
  files: DependencyFile[] = [],
): Promise<DependencyFile[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const details = await lstat(path, { bigint: true })
    if (details.isSymbolicLink() || await realpath(path) !== resolve(path) || !inside(path, root)) {
      throw new Error("Desktop dependency tree contains a link, alias or path escape")
    }
    if (details.isDirectory()) {
      await collectDependencyFiles(path, root, files)
      continue
    }
    if (!details.isFile() || details.nlink !== 1n) {
      throw new Error("Desktop dependency tree contains non-private file material")
    }
    if (details.size > BigInt(MAX_DEPENDENCY_FILE_BYTES)) {
      throw new Error("Desktop dependency file exceeds its byte limit")
    }
    if (files.length >= MAX_DEPENDENCY_FILES) {
      throw new Error("Desktop dependency tree exceeds its file limit")
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
    const handle = await open(path, constants.O_RDONLY | noFollow)
    let content: Buffer
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new Error("Desktop dependency file changed identity")
      }
      content = await handle.readFile()
      const after = await handle.stat({ bigint: true })
      assertStableOpenFile(before, after)
    } finally {
      await handle.close()
    }
    const afterPath = await lstat(path, { bigint: true })
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterPath.nlink !== 1n ||
      BigInt(content!.byteLength) !== afterPath.size
    ) throw new Error("Desktop dependency file changed after it was read")
    files.push({
      path,
      sha256: createHash("sha256").update(content!).digest("hex"),
      size: content!.byteLength,
    })
  }
  return files
}

function containedRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/")
  if (value === "" || value === ".." || value.startsWith("../")) {
    throw new Error("Desktop dependency manifest path is outside its root")
  }
  return value
}

function inside(path: string, root: string): boolean {
  const value = relative(resolve(root), resolve(path))
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
