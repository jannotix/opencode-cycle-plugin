import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import {
  assertNoReparseMaterial,
  readVerifiedRegularFile,
  type VerifiedFile,
} from "../release/verified-file.js"

export interface PreparedReceiptOutput {
  readonly directory: string
  readonly path: string
}

export async function prepareReceiptOutput(
  repositoryRoot: string,
  output: string,
  policy: { readonly basename: string; readonly lane?: readonly string[] },
): Promise<PreparedReceiptOutput> {
  validateSegments([...(policy.lane ?? []), policy.basename])
  if (!policy.basename.endsWith(".json")) throw new Error("Receipt output must use a JSON basename")
  const root = resolve(repositoryRoot)
  const directory = join(root, "target", "certification", ...(policy.lane ?? []))
  const expected = join(directory, policy.basename)
  if (resolve(output) !== expected) {
    throw new Error(`Receipt output must be the exact designated path: ${expected}`)
  }
  const relativePath = relative(root, expected).split(sep).join("/")
  if (await tracked(root, relativePath)) throw new Error(`Receipt output must not be tracked: ${relativePath}`)
  await ensureRealDirectoryChain(root, ["target", "certification", ...(policy.lane ?? [])])
  const existing = await lstat(expected).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error(`Receipt output already exists as a link or reparse point: ${relativePath}`)
    }
    await assertNoReparseMaterial([expected])
    throw new Error(`Receipt output already exists before the workload: ${relativePath}`)
  }
  return { directory, path: expected }
}

export async function writeReceiptAtomically(
  output: PreparedReceiptOutput,
  content: Uint8Array,
): Promise<VerifiedFile> {
  await assertRealDirectory(output.directory)
  const finalExisting = await lstat(output.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (finalExisting !== undefined) throw new Error("Receipt output is already published")
  const temporary = join(output.directory, `.${basename(output.path)}.${randomUUID()}.tmp`)
  let handle
  let published = false
  try {
    handle = await open(temporary, "wx", 0o600)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, output.path)
    published = true
    await unlink(temporary)
    return await readVerifiedRegularFile(output.path, {
      maxBytes: Math.max(content.byteLength, 1),
      root: output.directory,
    })
  } catch (error) {
    const cleanupFailures: unknown[] = []
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
    }
    for (const path of [temporary, ...(published ? [output.path] : [])]) {
      try {
        await unlink(path)
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) cleanupFailures.push(cleanupError)
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "Atomic receipt publication cleanup failed")
    }
    throw error
  }
}

export async function publishReceiptAtomically(
  output: PreparedReceiptOutput,
  content: Uint8Array,
  afterWrite: () => Promise<void>,
): Promise<VerifiedFile> {
  const receipt = await writeReceiptAtomically(output, content)
  try {
    await afterWrite()
    return receipt
  } catch (error) {
    try {
      await unlink(output.path)
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) {
        throw new AggregateError([error, cleanupError], "Invalid receipt cleanup failed")
      }
    }
    throw error
  }
}

async function ensureRealDirectoryChain(root: string, segments: readonly string[]): Promise<void> {
  const paths = [root]
  await assertRealDirectory(root, false)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    await assertRealDirectory(current, false)
    paths.push(current)
  }
  await assertNoReparseMaterial(paths)
}

async function assertRealDirectory(path: string, checkReparse = true): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Receipt output directory must not be a link, reparse point or alias: ${path}`)
  }
  if (checkReparse) await assertNoReparseMaterial([path])
  if (await realpath(path) !== resolve(path)) {
    throw new Error(`Receipt output directory must not be a link, reparse point or alias: ${path}`)
  }
}

async function tracked(root: string, path: string): Promise<boolean> {
  const child = Bun.spawn(["git", "ls-files", "--error-unmatch", "--", path], {
    cwd: root,
    stderr: "pipe",
    stdout: "ignore",
  })
  const exitCode = await child.exited
  if (exitCode === 0) return true
  if (exitCode === 1) return false
  throw new Error(`Cannot determine whether receipt output is tracked: ${(await new Response(child.stderr).text()).trim()}`)
}

function validateSegments(segments: readonly string[]): void {
  for (const segment of segments) {
    if (segment.length === 0 || basename(segment) !== segment || segment === "." || segment === "..") {
      throw new Error(`Receipt output lane is invalid: ${segment}`)
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
