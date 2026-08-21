import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

type Mode = "apply" | "dry-run"
type EntryKind = "directory" | "file"

export interface InventoryEntry {
  readonly kind: EntryKind
  readonly path: string
  readonly sha256: string
  readonly size: number
}

export interface InventoryDifference {
  readonly actual: InventoryEntry | null
  readonly expected: InventoryEntry | null
  readonly path: string
}

export interface MigrationPlan {
  readonly backup: string
  readonly config: string
  readonly newInstall: string
  readonly newLoader: string
  readonly newState: string
  readonly oldInstall: string
  readonly oldLoader: string
  readonly oldState: string
  readonly receipt: string
  readonly steps: readonly string[]
}

export interface ProcessInfo {
  readonly commandLine: string | null
  readonly executablePath: string | null
  readonly name: string
}

interface VerificationProbe {
  readonly doctor: unknown
  readonly health: { readonly protocol_version: number; readonly schema_version: number }
  readonly history: unknown
}

interface Verification {
  readonly doctor: "PASS"
  readonly health: { readonly protocolVersion: number; readonly schemaVersion: number }
  readonly history: "PASS"
}

export interface MigrationInput {
  readonly allowTestPaths?: boolean
  readonly backup: string
  readonly backupDatabase?: (sourceState: string, destination: string) => Promise<void>
  readonly binary: string
  readonly config: string
  readonly dist: string
  readonly faults?: Partial<Record<"backup" | "configWrite" | "loaderActivation" | "receiptPartialWrite" | "receiptPublish" | "receiptParentSync", () => Promise<void>>>
  readonly mode: Mode
  readonly newInstall: string
  readonly newState: string
  readonly oldInstall: string
  readonly oldState: string
  readonly plugins: string
  readonly processes?: () => Promise<readonly ProcessInfo[]>
  readonly receipt: string
  readonly verify?: (input: { binary: string; dataDirectory: string }) => Promise<VerificationProbe>
  readonly windowsReparseScan?: (root: string) => Promise<readonly WindowsReparseEntry[]>
}

export interface MigrationResult {
  readonly config: Record<string, unknown>
  readonly dryRun: boolean
  readonly plan: MigrationPlan
  readonly state: readonly InventoryEntry[]
  readonly verification: Verification | undefined
}

const OLD_AGENT_NAMES = ["WorkFlow Architect", "WorkFlow Executor", "WorkFlow Functional Reviewer", "WorkFlow Security and Architecture Reviewer", "WorkFlow Arbiter"] as const
const NEW_AGENT_NAMES = ["Cycle Architect", "Cycle Executor", "Cycle Functional Reviewer", "Cycle Security and Architecture Reviewer", "Cycle Arbiter"] as const
const PLAN_STEPS = ["backup", "copy-state", "activate-state", "activate-install", "activate-loader", "verify", "receipt"] as const

export async function migrateOpenCodeCycle(input: MigrationInput): Promise<MigrationResult> {
  const basePaths = normalize(input)
  validatePaths(basePaths, input.allowTestPaths === true)
  const paths = { ...basePaths, backup: await nextBackupPath(basePaths.backup) }
  const processes = await (input.processes ?? listWindowsProcesses)()
  if (processes.some((process) => isRelevantPreReleaseProcess(process, paths.oldInstall, paths.oldState))) {
    throw new Error("OpenCode Cycle migration refused because a pre-release owner process is running")
  }
  await assertDirectory(paths.oldState)
  await assertDirectory(paths.oldInstall)
  await assertDirectory(paths.dist)
  await assertFile(paths.binary)
  await assertFile(paths.oldLoader)
  await assertAbsent(paths.newState, "OpenCode Cycle state destination")
  await assertAbsent(paths.newInstall, "OpenCode Cycle installation destination")
  await assertAbsent(paths.newLoader, "OpenCode Cycle loader destination")
  await assertAbsent(paths.oldLoaderBackup, "pre-release loader backup")
  await assertAbsent(paths.receipt, "migration receipt")

  const configBytes = await readFile(paths.config)
  const config = migrateConfig(configBytes)
  const plan = migrationPlan(paths)
  if (paths.mode === "dry-run") {
    const state = await inventory(paths.oldState, input.windowsReparseScan)
    if (state.length === 0) throw new Error("pre-release state is empty")
    return { config, dryRun: true, plan, state, verification: undefined }
  }

  const temporary = {
    backup: sibling(paths.backup, "backup"),
    config: sibling(paths.config, "config"),
    install: sibling(paths.newInstall, "install"),
    loader: sibling(paths.newLoader, "loader"),
    state: sibling(paths.newState, "state"),
  }
  const owned = { backupTemporary: false, configTemporary: false, installTemporary: false, loaderTemporary: false, newLoader: false, stateTemporary: false }
  let state: InventoryEntry[] = []
  let configActivated = false
  let oldLoaderRenamed = false
  try {
    await mkdir(dirname(paths.backup), { recursive: true })
    await input.faults?.backup?.()
    await assertAbsent(temporary.backup, "temporary SQLite backup")
    owned.backupTemporary = true
    await (input.backupDatabase ?? backupWithWorkflowd)(paths.oldState, temporary.backup, paths.binary)
    await assertFile(temporary.backup)
    await syncFile(temporary.backup)
    await link(temporary.backup, paths.backup)
    await syncParent(dirname(paths.backup))
    await rm(temporary.backup, { force: true })
    owned.backupTemporary = false

    state = await inventory(paths.oldState, input.windowsReparseScan)
    if (state.length === 0) throw new Error("pre-release state is empty")
    await mkdir(temporary.state)
    owned.stateTemporary = true
    await copyDirectoryContents(paths.oldState, temporary.state, input.windowsReparseScan)
    const differences = compareInventories(state, await inventory(temporary.state, input.windowsReparseScan))
    if (differences.length !== 0) {
      throw new Error(`copied state did not match the pre-release inventory: ${JSON.stringify({ differenceCount: differences.length, differences: differences.slice(0, 20) })}`)
    }
    await rename(temporary.state, paths.newState)
    owned.stateTemporary = false

    await mkdir(temporary.install)
    owned.installTemporary = true
    await mkdir(join(temporary.install, "dist"))
    await copyDirectoryContents(paths.dist, join(temporary.install, "dist"), input.windowsReparseScan)
    await mkdir(join(temporary.install, "bin"))
    await copyFile(paths.binary, join(temporary.install, "bin", "workflowd.exe"), constants.COPYFILE_EXCL)
    await rename(temporary.install, paths.newInstall)
    owned.installTemporary = false

    await writeExclusive(temporary.loader, cycleLoaderSource())
    owned.loaderTemporary = true
    await input.faults?.configWrite?.()
    await writeExclusive(temporary.config, JSON.stringify(config, null, 2) + "\n")
    owned.configTemporary = true
    await rename(temporary.config, paths.config)
    owned.configTemporary = false
    configActivated = true
    await rename(paths.oldLoader, paths.oldLoaderBackup)
    oldLoaderRenamed = true
    await input.faults?.loaderActivation?.()
    await rename(temporary.loader, paths.newLoader)
    owned.loaderTemporary = false
    owned.newLoader = true

    const verification = validateVerification(await (input.verify ?? verifyInstalledCycle)({ binary: join(paths.newInstall, "bin", "workflowd.exe"), dataDirectory: paths.newState }))
    await writeReceipt(paths.receipt, paths, state, verification, input.faults)
    return { config, dryRun: false, plan, state, verification }
  } catch (error) {
    if (owned.newLoader) await rm(paths.newLoader, { force: true })
    if (oldLoaderRenamed && (await exists(paths.oldLoaderBackup)) && !(await exists(paths.oldLoader))) {
      await rename(paths.oldLoaderBackup, paths.oldLoader)
    }
    if (configActivated) await writeAtomic(paths.config, configBytes)
    if (owned.backupTemporary) await rm(temporary.backup, { force: true })
    if (owned.configTemporary) await rm(temporary.config, { force: true })
    if (owned.loaderTemporary) await rm(temporary.loader, { force: true })
    if (owned.installTemporary) await rm(temporary.install, { force: true, recursive: true })
    if (owned.stateTemporary) await rm(temporary.state, { force: true, recursive: true })
    throw error
  }
}

export function compareInventories(expected: readonly InventoryEntry[], actual: readonly InventoryEntry[]): InventoryDifference[] {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, inventoryMetadata(entry)]))
  const actualByPath = new Map(actual.map((entry) => [entry.path, inventoryMetadata(entry)]))
  const paths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort(compareText)
  return paths.flatMap((path) => {
    const expectedEntry = expectedByPath.get(path) ?? null
    const actualEntry = actualByPath.get(path) ?? null
    return sameInventoryEntry(expectedEntry, actualEntry) ? [] : [{ actual: actualEntry, expected: expectedEntry, path }]
  })
}

export function isRelevantPreReleaseProcess(process: ProcessInfo, oldInstall: string, oldState: string) {
  const name = process.name.toLowerCase()
  const oldBinary = normalizePath(join(oldInstall, "bin", "workflowd.exe"))
  const oldDataDirectory = normalizePath(oldState)
  const executable = process.executablePath === null ? "" : normalizePath(process.executablePath)
  const commandLine = process.commandLine ?? ""
  if (name === "workflowd.exe") {
    return executable === oldBinary || commandLineDataDirectories(commandLine).includes(oldDataDirectory) || commandLinePaths(commandLine).includes(oldBinary)
  }
  const desktopHost = ["opencode.exe", "opencode-desktop.exe", "electron.exe"].includes(name)
  const ownerReference = commandLinePaths(commandLine).includes(oldBinary) || commandLine.toLowerCase().split(/\s+/u).includes("opencode-workflow")
  return desktopHost && ownerReference
}

function commandLineDataDirectories(commandLine: string): string[] {
  return Array.from(
    commandLine.matchAll(/--data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/giu),
    (match) => normalizePath(match[1] ?? match[2] ?? match[3]!),
  )
}

function commandLinePaths(commandLine: string): string[] {
  return Array.from(commandLine.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/gu), (match) => normalizePath(match[1] ?? match[2] ?? match[3]!))
}

function normalize(input: MigrationInput) {
  const absolute = (value: string, name: string) => {
    if (!isAbsolute(value)) throw new Error(`${name} must be an explicit absolute path`)
    return resolve(value)
  }
  const config = absolute(input.config, "config")
  const plugins = absolute(input.plugins, "plugins")
  return { backup: absolute(input.backup, "backup"), binary: absolute(input.binary, "binary"), config, dist: absolute(input.dist, "dist"), mode: input.mode, newInstall: absolute(input.newInstall, "new-install"), newLoader: join(plugins, "opencode-cycle.js"), newState: absolute(input.newState, "new-state"), oldInstall: absolute(input.oldInstall, "old-install"), oldLoader: join(plugins, "opencode-workflow.js"), oldLoaderBackup: join(plugins, "opencode-workflow.js.pre-cycle-backup"), oldState: absolute(input.oldState, "old-state"), plugins, receipt: absolute(input.receipt, "receipt") }
}

function validatePaths(paths: ReturnType<typeof normalize>, allowTestPaths: boolean) {
  if (!allowTestPaths) validateLiveTargets(paths)
  if (basename(paths.config) !== "opencode.json" || !inside(dirname(paths.config), paths.plugins)) throw new Error("configuration paths are invalid")
  if (paths.newLoader === paths.oldLoader || paths.newState === paths.oldState || paths.newInstall === paths.oldInstall) throw new Error("migration source and destination must differ")
}

function validateLiveTargets(paths: ReturnType<typeof normalize>) {
  const userProfile = process.env.USERPROFILE
  const localAppData = process.env.LOCALAPPDATA
  if (!userProfile || !localAppData) throw new Error("required Windows profile paths are unavailable")
  const configRoot = resolve(userProfile, ".config", "opencode")
  const expected = { config: join(configRoot, "opencode.json"), plugins: join(configRoot, "plugins"), oldInstall: join(configRoot, "opencode-workflow"), newInstall: join(configRoot, "opencode-cycle"), oldState: resolve(localAppData, "OpenCode WorkFlow"), newState: resolve(localAppData, "OpenCode Cycle") }
  for (const [key, value] of Object.entries(expected)) if (paths[key as keyof typeof expected] !== value) throw new Error(`${key} does not match the approved OpenCode migration target`)
}

function migrationPlan(paths: ReturnType<typeof normalize>): MigrationPlan {
  return { backup: paths.backup, config: paths.config, newInstall: paths.newInstall, newLoader: paths.newLoader, newState: paths.newState, oldInstall: paths.oldInstall, oldLoader: paths.oldLoader, oldState: paths.oldState, receipt: paths.receipt, steps: PLAN_STEPS }
}

function migrateConfig(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("OpenCode configuration is not valid JSON") }
  if (!isRecord(parsed)) throw new Error("OpenCode configuration must be an object")
  const next = structuredClone(parsed)
  const agents = isRecord(next.agent) ? next.agent : {}
  next.agent = agents
  for (let index = 0; index < OLD_AGENT_NAMES.length; index += 1) {
    const oldName = OLD_AGENT_NAMES[index]!
    const newName = NEW_AGENT_NAMES[index]!
    if (agents[oldName] !== undefined && agents[newName] === undefined) agents[newName] = agents[oldName]
    delete agents[oldName]
  }
  agents["Cycle Executor"] = { model: "zai-coding-plan/glm-5.3", reasoningEffort: "max" }
  return next
}

interface WindowsReparseEntry { readonly attributes: number; readonly path: string }

async function inventory(root: string, windowsReparseScan: MigrationInput["windowsReparseScan"]): Promise<InventoryEntry[]> {
  await assertSafeDirectory(root)
  await rejectWindowsReparsePoints(root, windowsReparseScan)
  const entries: InventoryEntry[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const metadata = await lstat(absolute)
      rejectLink(metadata)
      const path = relative(root, absolute).replaceAll("\\", "/")
      if (metadata.isDirectory()) {
        entries.push({ kind: "directory", path, sha256: createHash("sha256").update("directory").digest("hex"), size: 0 })
        await walk(absolute)
      } else if (metadata.isFile()) {
        const bytes = await readFile(absolute)
        entries.push({ kind: "file", path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length })
      } else throw new Error("migration refuses non-file state entries")
    }
  }
  await walk(root)
  return entries.sort((left, right) => compareText(`${left.path}\0${left.kind}`, `${right.path}\0${right.kind}`))
}

async function copyDirectoryContents(source: string, destination: string, windowsReparseScan: MigrationInput["windowsReparseScan"], scanRoot = true) {
  if (scanRoot) await rejectWindowsReparsePoints(source, windowsReparseScan)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const metadata = await lstat(from)
    rejectLink(metadata)
    if (metadata.isDirectory()) { await mkdir(to); await copyDirectoryContents(from, to, windowsReparseScan, false) }
    else if (metadata.isFile()) await copyFile(from, to, constants.COPYFILE_EXCL)
    else throw new Error("migration refuses non-file state entries")
  }
}

function rejectLink(metadata: Awaited<ReturnType<typeof lstat>>) {
  if (metadata.isSymbolicLink()) throw new Error("migration refuses symbolic links, junctions and reparse points")
}

async function rejectWindowsReparsePoints(root: string, windowsReparseScan: MigrationInput["windowsReparseScan"]) {
  if (process.platform !== "win32" && windowsReparseScan === undefined) return
  const entries = await (windowsReparseScan ?? scanWindowsReparsePoints)(root)
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.attributes) || (entry.attributes & 0x400) === 0 || !isContainedRelativePath(entry.path)) {
      throw new Error("migration received malformed Windows reparse-point scan output")
    }
    throw new Error("migration refuses symbolic links, junctions and reparse points")
  }
}

async function scanWindowsReparsePoints(root: string): Promise<readonly WindowsReparseEntry[]> {
  const result = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$root = $env:OPENCODE_CYCLE_REPARSE_ROOT; $items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop); @($items | Where-Object { ([int]$_.Attributes -band 1024) -ne 0 } | ForEach-Object { [PSCustomObject]@{ path = $_.FullName; attributes = [int]$_.Attributes } }) | ConvertTo-Json -Compress"],
    { env: { ...process.env, OPENCODE_CYCLE_REPARSE_ROOT: root } },
  )
  if (result.exitCode !== 0) throw new Error("migration could not inspect Windows file attributes")
  const output = new TextDecoder().decode(result.stdout).trim()
  if (!output) return []
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { throw new Error("migration received malformed Windows reparse-point scan output") }
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !Number.isSafeInteger(entry.attributes)) throw new Error("migration received malformed Windows reparse-point scan output")
    const path = relative(root, resolve(entry.path)).replaceAll("\\", "/") || "."
    if (!isContainedRelativePath(path)) throw new Error("migration received malformed Windows reparse-point scan output")
    return { path, attributes: entry.attributes as number }
  })
}

async function backupWithWorkflowd(sourceState: string, destination: string, binary: string) {
  const child = Bun.spawn([binary, "--backup-data-dir", sourceState, "--backup-to", destination], { stderr: "ignore", stdout: "ignore" })
  if ((await child.exited) !== 0) throw new Error("SQLite backup failed")
}

async function verifyInstalledCycle(input: { binary: string; dataDirectory: string }): Promise<VerificationProbe> {
  const client = (await import(pathToFileURL(join(dirname(input.binary), "..", "dist", "client.js")).href)) as { LocalControlPlane: new (options: { binaryPath: string; dataDirectory: string; stopOwnedProcessOnDispose: boolean }) => { control(project: string, operation: "doctor"): Promise<unknown>; dispose(): Promise<void>; health(): Promise<{ protocol_version: number; schema_version: number }>; history(project: string, operation: { type: "verify" }): Promise<unknown> } }
  const control = new client.LocalControlPlane({ binaryPath: input.binary, dataDirectory: input.dataDirectory, stopOwnedProcessOnDispose: true })
  try { return { doctor: await control.control("migration-verification", "doctor"), health: await control.health(), history: await control.history("migration-verification", { type: "verify" }) } } finally { await control.dispose() }
}

function validateVerification(probe: VerificationProbe): Verification {
  if (probe.health.protocol_version !== 1 || probe.health.schema_version !== 17) throw new Error("Cycle health version check failed")
  if (!isRecord(probe.doctor) || probe.doctor.status !== "PASS" || probe.doctor.ledger !== "valid" || probe.doctor.schemaVersion !== 17) throw new Error("Cycle doctor verification failed")
  if (!isRecord(probe.history) || !isRecord(probe.history.chain) || probe.history.chain.status !== "valid" || !Array.isArray(probe.history.checkpoints) || probe.history.checkpoints.some((checkpoint) => !isRecord(checkpoint) || checkpoint.status !== "valid")) throw new Error("Cycle history verification failed")
  return { doctor: "PASS", health: { protocolVersion: 1, schemaVersion: 17 }, history: "PASS" }
}

async function writeReceipt(
  receipt: string,
  paths: ReturnType<typeof normalize>,
  state: readonly InventoryEntry[],
  verification: Verification,
  faults: MigrationInput["faults"],
) {
  await mkdir(dirname(receipt), { recursive: true })
  const payload = { copiedEntryCount: state.length, createdAt: new Date().toISOString(), paths: { backup: paths.backup, config: paths.config, newInstall: paths.newInstall, newState: paths.newState, oldInstall: paths.oldInstall, oldState: paths.oldState }, stateDigest: createHash("sha256").update(JSON.stringify(state)).digest("hex"), verification }
  const temporary = sibling(receipt, "receipt")
  let temporaryOwned = false
  let receiptOwned = false
  try {
    const contents = JSON.stringify(payload, null, 2) + "\n"
    const handle = await open(temporary, "wx")
    temporaryOwned = true
    try {
      const boundary = Math.ceil(contents.length / 2)
      await handle.writeFile(contents.slice(0, boundary))
      await faults?.receiptPartialWrite?.()
      await handle.writeFile(contents.slice(boundary))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await faults?.receiptPublish?.()
    await link(temporary, receipt)
    receiptOwned = true
    await faults?.receiptParentSync?.()
    await syncParent(dirname(receipt))
    await rm(temporary, { force: true })
    temporaryOwned = false
  } catch (error) {
    if (receiptOwned) await rm(receipt, { force: true })
    if (temporaryOwned) await rm(temporary, { force: true })
    throw error
  }
}

async function syncParent(path: string) {
  try {
    const handle = await open(path, "r")
    try { await handle.sync() } finally { await handle.close() }
  } catch (error) {
    if (!isNodeError(error, "EPERM") && !isNodeError(error, "EISDIR") && !isNodeError(error, "EINVAL")) throw error
  }
}

async function syncFile(path: string) {
  const handle = await open(path, "r+")
  try { await handle.sync() } finally { await handle.close() }
}

async function writeAtomic(destination: string, bytes: string | Buffer) {
  const temporary = sibling(destination, "restore")
  await writeExclusive(temporary, bytes)
  await rename(temporary, destination)
}

async function writeExclusive(path: string, contents: string | Buffer) {
  const handle = await open(path, "wx")
  try { await handle.writeFile(contents) } finally { await handle.close() }
}

async function listWindowsProcesses(): Promise<readonly ProcessInfo[]> {
  if (process.platform !== "win32") return []
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"])
  if (result.exitCode !== 0) throw new Error("unable to check for pre-release owner processes")
  const output = new TextDecoder().decode(result.stdout).trim()
  if (!output) return []
  const parsed: unknown = JSON.parse(output)
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((value) => isRecord(value) && typeof value.Name === "string" ? [{ name: value.Name, executablePath: typeof value.ExecutablePath === "string" ? value.ExecutablePath : null, commandLine: typeof value.CommandLine === "string" ? value.CommandLine : null }] : [])
}

async function assertAbsent(path: string, label: string) { if (await exists(path)) throw new Error(`${label} already exists`) }
async function assertDirectory(path: string) { const metadata = await stat(path); if (!metadata.isDirectory()) throw new Error(`expected directory: ${path}`) }
async function assertSafeDirectory(path: string) { const metadata = await lstat(path); rejectLink(metadata); if (!metadata.isDirectory()) throw new Error(`expected directory: ${path}`) }
async function assertFile(path: string) { const metadata = await stat(path); if (!metadata.isFile()) throw new Error(`expected file: ${path}`) }
async function exists(path: string) { try { await lstat(path); return true } catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error } }
async function nextBackupPath(base: string) {
  if (!(await exists(base))) return base
  const extension = extname(base)
  const stem = extension === "" ? base : base.slice(0, -extension.length)
  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const candidate = `${stem}.attempt-${attempt}${extension}`
    if (!(await exists(candidate))) return candidate
  }
  throw new Error("no unused SQLite backup attempt path is available")
}
function sibling(target: string, kind: string) { return join(dirname(target), `.${basename(target)}.${kind}.${randomUUID()}.tmp`) }
function basename(path: string) { return path.slice(path.lastIndexOf(sep) + 1) }
function inside(parent: string, child: string) { const value = relative(parent, child); return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value) }
function isContainedRelativePath(path: string) { return path === "." || (path !== "" && !path.startsWith("../") && path !== ".." && !isAbsolute(path)) }
function inventoryMetadata(entry: InventoryEntry): InventoryEntry { return { kind: entry.kind, path: entry.path, sha256: entry.sha256, size: entry.size } }
function sameInventoryEntry(left: InventoryEntry | null, right: InventoryEntry | null) { return left === right || (left !== null && right !== null && left.kind === right.kind && left.path === right.path && left.sha256 === right.sha256 && left.size === right.size) }
function compareText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0 }
function normalizePath(path: string) { return resolve(path).replaceAll("/", "\\").toLowerCase() }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException { return typeof error === "object" && error !== null && "code" in error && error.code === code }
function cycleLoaderSource() { return ['import { fileURLToPath } from "node:url"', 'import OpenCodeCycle from "../opencode-cycle/dist/index.js"', "", 'const binaryPath = fileURLToPath(new URL("../opencode-cycle/bin/workflowd.exe", import.meta.url))', "", "export default async function OpenCodeCyclePlugin(input) {", "  return OpenCodeCycle(input, { binaryPath })", "}", ""].join("\n") }

function parseArguments(values: readonly string[]): MigrationInput {
  let mode: Mode | undefined
  const argumentsByName = new Map<string, string>()
  const expected = new Set(["--config", "--old-state", "--new-state", "--old-install", "--new-install"])
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    if (value === "--apply" || value === "--dry-run") { if (mode !== undefined) throw new Error("choose exactly one of --dry-run or --apply"); mode = value.slice(2) as Mode; continue }
    if (!expected.has(value) || argumentsByName.has(value) || index + 1 >= values.length) throw new Error("expected --dry-run|--apply and explicit --config --old-state --new-state --old-install --new-install paths")
    argumentsByName.set(value, values[index + 1]!); index += 1
  }
  if (mode === undefined || argumentsByName.size !== expected.size) throw new Error("expected --dry-run|--apply and explicit --config --old-state --new-state --old-install --new-install paths")
  const root = resolve(import.meta.dir, "..", "..")
  const config = argumentsByName.get("--config")!
  return { backup: join(root, "target", "migration", "opencode-cycle-pre-release-backup.db"), binary: join(root, "target", "debug", "workflowd.exe"), config, dist: join(root, "packages", "opencode-cycle", "dist"), mode, newInstall: argumentsByName.get("--new-install")!, newState: argumentsByName.get("--new-state")!, oldInstall: argumentsByName.get("--old-install")!, oldState: argumentsByName.get("--old-state")!, plugins: join(dirname(config), "plugins"), receipt: join(root, "target", "migration", "opencode-cycle-migration-receipt.json") }
}

if (import.meta.main) {
  try { const result = await migrateOpenCodeCycle(parseArguments(Bun.argv.slice(2))); console.log(JSON.stringify({ dryRun: result.dryRun, plan: result.plan, stateEntryCount: result.state.length, verification: result.verification }, null, 2)) }
  catch (error) { console.error(error instanceof Error ? error.message : "migration failed"); process.exitCode = 1 }
}
