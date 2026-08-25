import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  lstat,
  open,
  opendir,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"

import { assertNoReparseMaterial, assertStableOpenFile } from "../release/verified-file.js"

const MAX_DEPENDENCY_FILES = 50_000
const MAX_DEPENDENCY_FILE_BYTES = 64 * 1024 * 1024
const MAX_DEPENDENCY_TREE_BYTES = 512 * 1024 * 1024
export const DESKTOP_LINKER_INPUT_MAGIC = "OPENCODE_CYCLE_GRAPH_V1\0"

export interface DesktopDependencyTreeReceipt {
  readonly dependencyFileCount: number
  readonly dependencyPackageCount: number
  readonly dependencyTotalBytes: number
  readonly dependencyTreeSha256: string
  readonly schemaVersion: 1
}

export interface DesktopDependencyTreeVerification {
  readonly abort: () => Promise<void>
  readonly contentTreeSha256: string
  readonly openLinkerInput: () => DesktopDependencyLinkerInput
  readonly receipt: DesktopDependencyTreeReceipt
  readonly verifyAndClose: () => Promise<DesktopDependencyTreeReceipt>
}

export interface DesktopDependencyLinkerInput {
  readonly close: () => Promise<void>
  readonly contentTreeSha256: string
  readonly createReadStream: () => NodeJS.ReadableStream
  readonly fileCount: number
}

interface HeldDependencyFile {
  readonly content: Buffer
  readonly handle: FileHandle
  readonly metadata: string
  readonly path: string
  readonly relativePath: string
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
      contentTreeSha256: initial.contentTreeSha256,
      openLinkerInput() {
        if (closed) throw new Error("Desktop dependency verification handles are closed")
        const files = [...held].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath))
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
              for (const file of files) {
                const name = Buffer.from(file.relativePath, "utf8")
                const frame = Buffer.alloc(12)
                frame.writeUInt32LE(name.byteLength, 0)
                frame.writeBigUInt64LE(BigInt(file.content.byteLength), 4)
                yield frame
                yield name
                yield file.content
              }
            }
            return Readable.from(frames())
          },
          fileCount: files.length,
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
      const metadata = membershipMetadata(after)
      const sha256 = createHash("sha256").update(content).digest("hex")
      records.push(
        `${name}\0file\0${metadata}\0${sha256}\n`,
      )
      contentRecords.push(`${name}\0${content.byteLength}\0${sha256}\n`)
      if (held === undefined) await handle.close()
      else held.push({ content, handle, metadata, path, relativePath: name })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }
  await visit(root)
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

function membershipMetadata(details: Awaited<ReturnType<typeof lstat>>): string {
  const value = details as unknown as {
    readonly ctimeNs?: bigint
    readonly dev: bigint | number
    readonly ino: bigint | number
    readonly mode: bigint | number
    readonly mtimeMs: number
    readonly mtimeNs?: bigint
    readonly nlink: bigint | number
    readonly size: bigint | number
  }
  return [
    String(value.dev),
    String(value.ino),
    String(value.size),
    value.mtimeNs === undefined ? String(value.mtimeMs) : String(value.mtimeNs),
    value.ctimeNs === undefined ? "unavailable" : String(value.ctimeNs),
    String(value.nlink),
    String(value.mode),
  ].join("\0")
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
