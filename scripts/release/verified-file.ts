import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises"
import type { BigIntStats } from "node:fs"
import { basename, dirname, relative, resolve, sep } from "node:path"

export interface VerifiedFile {
  readonly content: Buffer
  readonly name: string
  readonly path: string
  readonly sha256: string
  readonly size: number
}

interface VerifiedRoot {
  readonly path: string
  readonly realPath: string
  readonly stats: BigIntStats
}

export async function readVerifiedFileDirectory(directory: string): Promise<VerifiedFile[]> {
  const root = await verifyRoot(directory)
  const entries = await readdir(root.path, { withFileTypes: true })
  const files: VerifiedFile[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Release root contains a directory, link, alias or non-file entry: ${entry.name}`)
    }
    files.push(await readVerifiedRegularFile(resolve(root.path, entry.name), { root }))
  }
  await assertSameRoot(root)
  return files
}

export async function readVerifiedRegularFile(
  path: string,
  options: { readonly maxBytes?: number; readonly root?: string | VerifiedRoot } = {},
): Promise<VerifiedFile> {
  const resolvedPath = resolve(path)
  const root = typeof options.root === "object"
    ? options.root
    : await verifyRoot(options.root ?? dirname(resolvedPath))
  const relativePath = relative(root.path, resolvedPath).split(sep).join("/")
  if (relativePath !== basename(resolvedPath)) {
    throw new Error(`Release file must be one direct contained file: ${relativePath}`)
  }
  const entry = await lstat(resolvedPath, { bigint: true })
  assertRegularSingleLink(entry, basename(resolvedPath))
  const resolvedRealPath = await realpath(resolvedPath)
  if (resolvedRealPath !== resolve(root.realPath, basename(resolvedPath))) {
    throw new Error(`Release file escapes its root through a link or alias: ${basename(resolvedPath)}`)
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  let handle: FileHandle | undefined
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | noFollow)
    const before = await handle.stat({ bigint: true })
    assertRegularSingleLink(before, basename(resolvedPath))
    assertSameIdentity(entry, before, "Release file changed while it was opened")
    if (options.maxBytes !== undefined && before.size > BigInt(options.maxBytes)) {
      throw new Error(`Release file exceeds its byte limit: ${basename(resolvedPath)}`)
    }
    const content = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    assertStableOpenFile(before, after)
    if (BigInt(content.byteLength) !== after.size) {
      throw new Error(`Release file size changed while it was read: ${basename(resolvedPath)}`)
    }
    await assertSameRoot(root)
    return {
      content,
      name: basename(resolvedPath),
      path: resolvedPath,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
    }
  } finally {
    await handle?.close()
  }
}

export function assertStableOpenFile(before: BigIntStats, after: BigIntStats): void {
  assertSameIdentity(before, after, "Release file identity changed while it was read")
  if (
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.nlink !== after.nlink
  ) {
    throw new Error("Release file metadata changed while it was read")
  }
}

async function verifyRoot(directory: string): Promise<VerifiedRoot> {
  const path = resolve(directory)
  const stats = await lstat(path, { bigint: true })
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Release root must be a real directory, not a file, link or alias")
  }
  const realPath = await realpath(path)
  if (realPath !== path) {
    throw new Error("Release root must not be a symlink, junction, reparse point or alias")
  }
  return { path, realPath, stats }
}

async function assertSameRoot(root: VerifiedRoot): Promise<void> {
  const after = await lstat(root.path, { bigint: true })
  if (!after.isDirectory() || after.isSymbolicLink() || await realpath(root.path) !== root.realPath) {
    throw new Error("Release root changed into a link or alias while it was read")
  }
  assertSameIdentity(root.stats, after, "Release root identity changed while it was read")
}

function assertRegularSingleLink(stats: BigIntStats, name: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Release file must be regular and must not be a link: ${name}`)
  }
  if (stats.nlink !== 1n) {
    throw new Error(`Release file must not be a hard link: ${name}`)
  }
}

function assertSameIdentity(left: BigIntStats, right: BigIntStats, message: string): void {
  if (left.dev !== right.dev || left.ino !== right.ino) throw new Error(message)
}
