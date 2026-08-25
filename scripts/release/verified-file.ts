import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises"
import { basename, dirname, relative, resolve, sep, win32 } from "node:path"

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

interface SnapshotEntry {
  readonly name: string
  readonly path: string
  readonly realPath: string
  readonly stats: BigIntStats
}

interface DirectorySnapshot {
  readonly entries: readonly SnapshotEntry[]
  readonly root: VerifiedRoot
}

interface ReaderHooks {
  readonly afterFilesRead?: (directory: string) => Promise<void>
  readonly afterHandleClosed?: (path: string) => Promise<void>
  readonly assertNoReparse?: (paths: readonly string[]) => Promise<void>
}

interface VerifiedFileReader {
  readDirectory(directory: string): Promise<VerifiedFile[]>
  readFile(path: string, options?: { readonly maxBytes?: number; readonly root?: string }): Promise<VerifiedFile>
}

const productionReader = createReader({})
let windowsInspector: WindowsReparseInspector | undefined
const windowsInspectorReady = process.platform === "win32"
  ? Promise.resolve().then(async () => {
    windowsInspector = new WindowsReparseInspector()
    await windowsInspector.inspect([])
  })
  : Promise.resolve()
await windowsInspectorReady

export function readVerifiedFileDirectory(directory: string): Promise<VerifiedFile[]> {
  return productionReader.readDirectory(directory)
}

export function readVerifiedRegularFile(
  path: string,
  options: { readonly maxBytes?: number; readonly root?: string } = {},
): Promise<VerifiedFile> {
  return productionReader.readFile(path, options)
}

export function createVerifiedFileReaderForTests(hooks: ReaderHooks): VerifiedFileReader {
  return createReader(hooks)
}

export function assertNoReparseMaterial(paths: readonly string[]): Promise<void> {
  return assertNoWindowsReparse(paths)
}

export function assertStableOpenFile(before: BigIntStats, after: BigIntStats): void {
  assertSameIdentity(before, after, "Release file identity changed while it was read")
  if (!sameMetadata(before, after)) {
    throw new Error("Release file metadata changed while it was read")
  }
}

export function sameCanonicalPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return left === right
  return normalizeWindowsPath(left) === normalizeWindowsPath(right)
}

function createReader(hooks: ReaderHooks): VerifiedFileReader {
  const reparseCheck = hooks.assertNoReparse ?? assertNoWindowsReparse

  const verifyRoot = async (directory: string): Promise<VerifiedRoot> => {
    const path = resolve(directory)
    const stats = await lstat(path, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Release root must be a real directory, not a file, link or alias")
    }
    const realPath = await realpath(path)
    const realStats = await lstat(realPath, { bigint: true })
    await reparseCheck([path, realPath])
    if (
      !sameCanonicalPath(realPath, path) &&
      (process.platform !== "win32" || !sameIdentity(stats, realStats))
    ) {
      throw new Error("Release root must not be a symlink, junction, reparse point or alias")
    }
    return { path, realPath, stats }
  }

  const snapshotEntry = async (root: VerifiedRoot, name: string): Promise<SnapshotEntry> => {
    const path = resolve(root.path, name)
    const relativePath = relative(root.path, path).split(sep).join("/")
    if (relativePath !== name || name !== basename(name)) {
      throw new Error(`Release file must be one direct contained file: ${relativePath}`)
    }
    const stats = await lstat(path, { bigint: true })
    assertRegularSingleLink(stats, name)
    const realPath = await realpath(path)
    if (!sameCanonicalPath(realPath, resolve(root.realPath, name))) {
      throw new Error(`Release file escapes its root through a link or alias: ${name}`)
    }
    return { name, path, realPath, stats }
  }

  const snapshotDirectory = async (directory: string): Promise<DirectorySnapshot> => {
    const root = await verifyRoot(directory)
    const entries = await readdir(root.path, { withFileTypes: true })
    const sorted = entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of sorted) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Release root contains a directory, link, alias or non-file entry: ${entry.name}`)
      }
    }
    const snapshots = await Promise.all(sorted.map((entry) => snapshotEntry(root, entry.name)))
    await reparseCheck(snapshots.map((entry) => entry.path))
    return { entries: snapshots, root }
  }

  const assertSameRoot = async (root: VerifiedRoot): Promise<void> => {
    const after = await lstat(root.path, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink()) {
      throw new Error("Release root changed into a link or alias while it was read")
    }
    if (!sameCanonicalPath(await realpath(root.path), root.realPath)) {
      throw new Error("Release root realpath changed while it was read")
    }
    assertSameIdentity(root.stats, after, "Release root identity changed while it was read")
  }

  const readSnapshotEntry = async (
    root: VerifiedRoot,
    entry: SnapshotEntry,
    maxBytes?: number,
  ): Promise<VerifiedFile> => {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
    let handle: FileHandle | undefined
    let content: Buffer
    let after: BigIntStats
    try {
      handle = await open(entry.path, constants.O_RDONLY | noFollow)
      const before = await handle.stat({ bigint: true })
      assertRegularSingleLink(before, entry.name)
      assertSameIdentity(entry.stats, before, "Release file changed while it was opened")
      if (!sameMetadata(entry.stats, before)) {
        throw new Error(`Release file metadata changed before it was opened: ${entry.name}`)
      }
      if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
        throw new Error(`Release file exceeds its byte limit: ${entry.name}`)
      }
      content = await handle.readFile()
      after = await handle.stat({ bigint: true })
      assertStableOpenFile(before, after)
      if (BigInt(content.byteLength) !== after.size) {
        throw new Error(`Release file size changed while it was read: ${entry.name}`)
      }
    } finally {
      await handle?.close()
    }
    await hooks.afterHandleClosed?.(entry.path)
    const pathAfter = await lstat(entry.path, { bigint: true })
    assertRegularSingleLink(pathAfter, entry.name)
    if (await realpath(entry.path) !== entry.realPath) {
      throw new Error(`Release file path was replaced through a link or alias: ${entry.name}`)
    }
    assertSameIdentity(after!, pathAfter, `Release file path identity was replaced: ${entry.name}`)
    if (!sameMetadata(after!, pathAfter)) {
      throw new Error(`Release file path metadata changed after it was read: ${entry.name}`)
    }
    return {
      content: content!,
      name: entry.name,
      path: entry.path,
      sha256: createHash("sha256").update(content!).digest("hex"),
      size: content!.byteLength,
    }
  }

  const assertSameDirectory = async (
    before: DirectorySnapshot,
    after: DirectorySnapshot,
  ): Promise<void> => {
    assertSameIdentity(before.root.stats, after.root.stats, "Release root identity changed")
    if (before.root.realPath !== after.root.realPath || !sameMetadata(before.root.stats, after.root.stats)) {
      throw new Error("Release root metadata changed while files were read")
    }
    if (
      before.entries.length !== after.entries.length ||
      before.entries.some((entry, index) => {
        const candidate = after.entries[index]
        return candidate === undefined ||
          entry.name !== candidate.name ||
          entry.realPath !== candidate.realPath ||
          !sameIdentity(entry.stats, candidate.stats) ||
          !sameMetadata(entry.stats, candidate.stats)
      })
    ) {
      throw new Error("Release directory membership or metadata changed while files were read")
    }
  }

  return {
    async readDirectory(directory) {
      const before = await snapshotDirectory(directory)
      const files: VerifiedFile[] = []
      for (const entry of before.entries) files.push(await readSnapshotEntry(before.root, entry))
      await hooks.afterFilesRead?.(before.root.path)
      const after = await snapshotDirectory(before.root.path)
      await assertSameDirectory(before, after)
      return files
    },
    async readFile(path, options = {}) {
      const resolvedPath = resolve(path)
      const root = await verifyRoot(options.root ?? dirname(resolvedPath))
      const entry = await snapshotEntry(root, basename(resolvedPath))
      await reparseCheck([root.path, entry.path])
      const file = await readSnapshotEntry(root, entry, options.maxBytes)
      await reparseCheck([root.path, entry.path])
      await assertSameRoot(root)
      return file
    },
  }
}

async function assertNoWindowsReparse(paths: readonly string[]): Promise<void> {
  if (process.platform !== "win32") return
  await windowsInspectorReady
  windowsInspector ??= new WindowsReparseInspector()
  const value = await windowsInspector.inspect(paths.map(windowsExtendedLengthPath))
  if (
    !isRecord(value) ||
    !Array.isArray(value.values) ||
    value.values.length !== paths.length ||
    value.values.some((item) => typeof item !== "boolean")
  ) {
    throw new Error("Windows reparse detection returned malformed output")
  }
  if (value.values.some(Boolean)) throw new Error("Release material contains a Windows reparse point")
}

class WindowsReparseInspector {
  readonly #child: ReturnType<typeof spawn>
  #buffer = ""
  #closed: unknown
  #queue = Promise.resolve()
  #stderr = ""
  #waiters: Array<{ reject: (error: unknown) => void; resolve: (value: unknown) => void }> = []

  constructor() {
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined) throw new Error("Windows reparse detection requires SystemRoot")
    const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const script = "$ErrorActionPreference='Stop';while($line=[Console]::In.ReadLine()){try{$request=$line|ConvertFrom-Json;$values=@();foreach($path in $request.paths){$item=Get-Item -LiteralPath $path -Force;$values += [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)};@{values=$values}|ConvertTo-Json -Compress}catch{@{error='failed'}|ConvertTo-Json -Compress}}"
    this.#child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { PSModulePath: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"), SystemRoot: systemRoot },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    })
    if (this.#child.stdout === null || this.#child.stderr === null) {
      this.close(new Error("Windows reparse detection failed closed: worker pipes are unavailable"))
      return
    }
    this.#child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")))
    this.#child.stderr.on("data", (chunk: Buffer) => { this.#stderr += chunk.toString("utf8") })
    this.#child.once("error", (error) => this.close(error))
    this.#child.once("exit", () => this.close(new Error(`Windows reparse detection failed closed: ${this.diagnostic()}`)))
  }

  inspect(paths: readonly string[]): Promise<unknown> {
    const result = this.#queue.then(() => this.request(paths))
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  private request(paths: readonly string[]): Promise<unknown> {
    if (this.#closed !== undefined || this.#child.stdin === null) return Promise.reject(this.#closed ?? new Error("Windows reparse detection failed closed"))
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
      this.#child.stdin!.write(`${JSON.stringify({ paths })}\n`, "utf8", (error) => { if (error !== null) this.close(error) })
    })
  }

  private consume(text: string): void {
    this.#buffer += text
    for (;;) {
      const index = this.#buffer.indexOf("\n")
      if (index < 0) return
      const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1)
      const waiter = this.#waiters.shift()
      if (waiter === undefined) { this.close(new Error("Windows reparse detection returned an unsolicited response")); return }
      try { waiter.resolve(JSON.parse(line) as unknown) } catch { waiter.reject(new Error("Windows reparse detection returned malformed output")) }
    }
  }

  private close(error: unknown): void {
    if (this.#closed !== undefined) return
    this.#closed = error
    while (this.#waiters.length > 0) this.#waiters.shift()!.reject(error)
  }

  private diagnostic(): string {
    const value = this.#stderr.replace(/[A-Za-z]:[^\s;]*/gu, "<path>").trim()
    return value.length === 0 ? "worker exited without stderr" : value
  }
}

function windowsExtendedLengthPath(path: string): string {
  const absolute = win32.resolve(path)
  if (absolute.startsWith("\\\\?\\")) return absolute
  if (absolute.startsWith("\\\\")) return `\\\\?\\UNC\\${absolute.slice(2)}`
  return `\\\\?\\${absolute}`
}

function normalizeWindowsPath(path: string): string {
  const normalized = win32.normalize(path).replaceAll("/", "\\")
  const withoutExtendedPrefix = normalized.startsWith("\\\\?\\UNC\\")
    ? `\\\\${normalized.slice("\\\\?\\UNC\\".length)}`
    : normalized.startsWith("\\\\?\\")
      ? normalized.slice("\\\\?\\".length)
      : normalized
  return withoutExtendedPrefix.toLowerCase()
}

function assertRegularSingleLink(stats: BigIntStats, name: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Release file must be regular and must not be a link: ${name}`)
  }
  if (stats.nlink !== 1n) throw new Error(`Release file must not be a hard link: ${name}`)
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertSameIdentity(left: BigIntStats, right: BigIntStats, message: string): void {
  if (!sameIdentity(left, right)) throw new Error(message)
}

function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
