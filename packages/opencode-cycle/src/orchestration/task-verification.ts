import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { spawn } from "bun"

import type { ArchitecturePlanInput } from "../client.js"

const execFileAsync = promisify(execFile)
const OUTPUT_LIMIT_BYTES = 64 * 1024
const OUTPUT_PREVIEW_CHARACTERS = 4_096
const DEFAULT_TIMEOUT_MILLIS = 120_000
const TERMINATION_GRACE_MILLIS = 500
const TERMINATION_LIMIT_MILLIS = 5_000
const FORBIDDEN_EXECUTABLES = new Set([
  "bash", "cmd", "del", "env", "fish", "git", "powershell", "pwsh", "rm", "sh",
  "shutdown", "sudo", "su", "wsl", "zsh",
])
const FORBIDDEN_ARGUMENTS = new Set([
  "&&", "||", ";", "|", "<", ">", "deploy", "destroy", "drop", "publish", "push", "reset",
])

type PlannedTask = ArchitecturePlanInput["tasks"][number]

export interface TaskVerificationInput {
  readonly baseRevision: string
  readonly changedPaths: readonly string[]
  readonly directory: string
  readonly revision: string
  readonly signal?: AbortSignal
  readonly task: PlannedTask
  readonly timeoutMillis?: number
}

export interface TaskVerificationCommandReceipt {
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly id: string
  readonly invocation: string
  readonly outputDigest: string
  readonly outputPreview: string
  readonly status: "failed" | "passed" | "timeout"
  readonly tool: string
}

export interface TaskVerificationReceipt {
  readonly baseRevision: string
  readonly bindingError?: string
  readonly changedPaths: readonly string[]
  readonly commands: readonly TaskVerificationCommandReceipt[]
  readonly passed: boolean
  readonly revision: string
  readonly taskId: string
}

export async function runTaskVerification(input: TaskVerificationInput): Promise<TaskVerificationReceipt> {
  input.signal?.throwIfAborted()
  const bindingError = await revisionBindingError(input)
  if (bindingError !== null) return failedReceipt(input, bindingError)

  const commands: TaskVerificationCommandReceipt[] = []
  for (const invocation of input.task.verification_commands) {
    input.signal?.throwIfAborted()
    commands.push(await runVerificationCommand(input.directory, invocation, input.timeoutMillis, input.signal))
    const postCommandBindingError = await revisionBindingError(input)
    if (postCommandBindingError !== null) {
      return failedReceipt(input, postCommandBindingError, commands)
    }
    if (commands.at(-1)?.status !== "passed") break
  }
  return {
    baseRevision: input.baseRevision,
    changedPaths: [...input.changedPaths],
    commands,
    passed: commands.length === input.task.verification_commands.length && commands.every((command) => command.status === "passed"),
    revision: input.revision,
    taskId: input.task.id,
  }
}

export function parseVerificationCommand(invocation: string): readonly [string, readonly string[]] {
  if (!invocation.trim() || invocation.length > 4_096 || /[\0\r\n]/u.test(invocation)) {
    throw new Error("Verification command must be a bounded shell-free invocation")
  }
  const parts = splitCommand(invocation)
  if (parts.length === 0) throw new Error("Verification command is empty")
  const tool = parts[0] as string
  const executable = tool.toLowerCase().replaceAll("\\", "/").split("/").at(-1)?.replace(/\.exe$/u, "")
  if (executable === undefined || FORBIDDEN_EXECUTABLES.has(executable)) {
    throw new Error(`Verification command uses forbidden executable: ${tool}`)
  }
  const forbidden = parts.slice(1).find((argument) => FORBIDDEN_ARGUMENTS.has(argument.toLowerCase()))
  if (forbidden !== undefined) throw new Error(`Verification command uses forbidden argument: ${forbidden}`)
  return [tool, parts.slice(1)]
}

async function runVerificationCommand(
  directory: string,
  invocation: string,
  timeoutMillis = DEFAULT_TIMEOUT_MILLIS,
  signal: AbortSignal | undefined,
): Promise<TaskVerificationCommandReceipt> {
  let tool: string
  let args: readonly string[]
  try {
    ;[tool, args] = parseVerificationCommand(invocation)
  } catch (error) {
    return invalidCommandReceipt(invocation, error)
  }

  let child: ReturnType<typeof spawnVerificationProcess>
  try {
    child = spawnVerificationProcess(directory, tool, args)
  } catch (error) {
    return failedCommandReceipt(invocation, tool, args, error)
  }

  let aborted = false
  let outputExceeded = false
  let timedOut = false
  let terminationError: unknown
  let terminationPromise: Promise<void> | undefined
  const terminate = (): void => {
    terminationPromise ??= terminateProcessTree(child).catch((error: unknown) => {
      terminationError = error
    })
  }
  const onAbort = (): void => { aborted = true; terminate() }
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted === true) onAbort()
  const timeout = setTimeout(() => { timedOut = true; terminate() }, boundedTimeout(timeoutMillis))

  try {
    const perStreamLimit = OUTPUT_LIMIT_BYTES / 2
    const [stdout, stderr, exitCode] = await Promise.all([
      capture(child.stdout, perStreamLimit, () => { outputExceeded = true; terminate() }),
      capture(child.stderr, perStreamLimit, () => { outputExceeded = true; terminate() }),
      child.exited,
    ])
    terminate()
    await terminationPromise
    if (aborted) signal?.throwIfAborted()
    if (terminationError !== undefined) {
      return failedCommandReceipt(invocation, tool, args, terminationError, timedOut)
    }
    return {
      args,
      exitCode,
      id: randomUUID(),
      invocation,
      outputDigest: digest(`${stdout.digest}\0${stderr.digest}`),
      outputPreview: truncate(`${stdout.preview}${stderr.preview}`, OUTPUT_PREVIEW_CHARACTERS),
      status: timedOut ? "timeout" : exitCode === 0 && !outputExceeded ? "passed" : "failed",
      tool,
    }
  } catch (error) {
    if (aborted) signal?.throwIfAborted()
    return failedCommandReceipt(invocation, tool, args, error, timedOut)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }
}

function spawnVerificationProcess(directory: string, tool: string, args: readonly string[]) {
  return spawn({
    cmd: [tool, ...args],
    cwd: directory,
    detached: true,
    env: verificationEnvironment(),
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  })
}

type VerificationProcess = ReturnType<typeof spawnVerificationProcess>

async function terminateProcessTree(child: VerificationProcess): Promise<void> {
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child)
    return
  }
  signalProcessGroup(child.pid, "SIGTERM")
  if (!(await waitForProcessGroupExit(child.pid, TERMINATION_GRACE_MILLIS))) {
    signalProcessGroup(child.pid, "SIGKILL")
  }
  await waitForExit(child.exited, TERMINATION_LIMIT_MILLIS)
  if (!(await waitForProcessGroupExit(child.pid, TERMINATION_LIMIT_MILLIS))) {
    throw new Error("Verification process group did not terminate")
  }
}

async function terminateWindowsProcessTree(child: VerificationProcess): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
  const killer = spawn({
    cmd: [join(systemRoot, "System32", "taskkill.exe"), "/PID", String(child.pid), "/T", "/F"],
    env: verificationEnvironment(),
    stdin: "ignore",
    stderr: "ignore",
    stdout: "ignore",
    windowsHide: true,
  })
  if (!(await waitForExit(killer.exited, TERMINATION_LIMIT_MILLIS))) {
    killer.kill()
    if (!(await waitForExit(killer.exited, TERMINATION_GRACE_MILLIS))) {
      throw new Error("Windows process-tree terminator did not exit")
    }
  }
  if (!(await waitForExit(child.exited, TERMINATION_LIMIT_MILLIS))) {
    child.kill()
    if (!(await waitForExit(child.exited, TERMINATION_GRACE_MILLIS))) {
      throw new Error("Verification process did not terminate")
    }
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMillis: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMillis
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
      throw error
    }
    await delay(25)
  }
  return false
}

async function waitForExit(exited: Promise<number>, timeoutMillis: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMillis)
    void exited.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function revisionBindingError(input: TaskVerificationInput): Promise<string | null> {
  try {
    if (!/^[0-9a-f]{40,64}$/u.test(input.baseRevision) || !/^[0-9a-f]{40,64}$/u.test(input.revision)) {
      return "Task verification revisions are malformed"
    }
    if ((await git(input.directory, ["rev-parse", "HEAD"])) !== input.revision) {
      return "Submitted revision is not the current worktree revision"
    }
    if ((await git(input.directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) !== "") {
      return "Submitted revision has uncommitted worktree changes"
    }
    await git(input.directory, ["rev-parse", "--verify", `${input.baseRevision}^{commit}`])
    await git(input.directory, ["rev-parse", "--verify", `${input.revision}^{commit}`])
    await git(input.directory, ["merge-base", "--is-ancestor", input.baseRevision, input.revision])
    if (new Set(input.changedPaths.map(normalizePath)).size !== input.changedPaths.length) {
      return "Submitted changed paths contain duplicates"
    }
    const actualChangedPaths = nulList(await git(input.directory, [
      "diff", "--name-only", "-z", "--no-renames", input.baseRevision, input.revision,
    ])).map(normalizePath)
    if (!sameSet(actualChangedPaths, input.changedPaths.map(normalizePath))) {
      return "Submitted changed paths do not match the exact revision diff"
    }
    const unauthorized = input.changedPaths.map(normalizePath)
      .filter((path) => !input.task.write_scopes.some((scope) => contains(scope, path)))
    if (unauthorized.length !== 0) {
      return `Submitted revision changes paths outside the task write scopes: ${unauthorized.join(", ")}`
    }
    return null
  } catch {
    return "Task verification could not prove the submitted revision binding"
  }
}

function failedReceipt(
  input: TaskVerificationInput,
  bindingError: string,
  commands: readonly TaskVerificationCommandReceipt[] = [],
): TaskVerificationReceipt {
  return {
    baseRevision: input.baseRevision, bindingError, changedPaths: [...input.changedPaths], commands,
    passed: false, revision: input.revision, taskId: input.task.id,
  }
}

function invalidCommandReceipt(invocation: string, error: unknown): TaskVerificationCommandReceipt {
  const message = errorMessage(error)
  return {
    args: [], exitCode: null, id: randomUUID(), invocation, outputDigest: digest(message),
    outputPreview: truncate(message, OUTPUT_PREVIEW_CHARACTERS), status: "failed", tool: "invalid",
  }
}

function failedCommandReceipt(
  invocation: string,
  tool: string,
  args: readonly string[],
  error: unknown,
  timedOut = false,
): TaskVerificationCommandReceipt {
  const message = errorMessage(error)
  return {
    args, exitCode: null, id: randomUUID(), invocation, outputDigest: digest(message),
    outputPreview: truncate(message, OUTPUT_PREVIEW_CHARACTERS), status: timedOut ? "timeout" : "failed", tool,
  }
}

async function capture(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLimit: () => void,
): Promise<{ readonly digest: string; readonly preview: string }> {
  const hash = createHash("sha256")
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let bytes = 0
  let preview = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = Math.max(0, limit - bytes)
    const bounded = value.byteLength <= remaining ? value : value.slice(0, remaining)
    if (bounded.byteLength !== 0) {
      hash.update(bounded)
      bytes += bounded.byteLength
      if (preview.length < OUTPUT_PREVIEW_CHARACTERS) preview += decoder.decode(bounded, { stream: true })
    }
    if (value.byteLength > remaining) { onLimit(); break }
  }
  preview += decoder.decode()
  return { digest: hash.digest("hex"), preview: truncate(preview, OUTPUT_PREVIEW_CHARACTERS) }
}

function verificationEnvironment(): Record<string, string> {
  const environment: Record<string, string> = { CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" }
  for (const name of [
    "APPDATA", "BUN_INSTALL", "CARGO_HOME", "DOTNET_ROOT", "HOME", "JAVA_HOME", "LANG", "LC_ALL",
    "LOCALAPPDATA", "PATH", "PATHEXT", "RUSTUP_HOME", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP",
    "TMPDIR", "USERPROFILE", "WINDIR", "XDG_CACHE_HOME",
  ]) {
    const value = process.env[name]
    if (value !== undefined && value !== "") environment[name] = value
  }
  const temporary = tmpdir()
  environment.TEMP ??= temporary
  environment.TMP ??= temporary
  environment.TMPDIR ??= temporary
  return environment
}

function boundedTimeout(timeoutMillis: number): number {
  if (!Number.isFinite(timeoutMillis) || timeoutMillis <= 0) return DEFAULT_TIMEOUT_MILLIS
  return Math.min(Math.trunc(timeoutMillis), 7_200_000)
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort()
  const normalizedRight = [...new Set(right)].sort()
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function contains(scope: string, path: string): boolean {
  const normalizedScope = normalizePath(scope).replace(/\/$/u, "")
  if (normalizedScope === "" || normalizedScope === ".") return true
  return path === normalizedScope || path.startsWith(`${normalizedScope}/`)
}

function normalizePath(path: string): string { return path.replaceAll("\\", "/") }
function nulList(value: string): string[] { return value.split("\0").filter(Boolean) }

function splitCommand(invocation: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  for (let index = 0; index < invocation.length; index += 1) {
    const character = invocation[index] as string
    if (quote !== null) {
      if (character === quote) quote = null
      else if (character === "\\" && quote === '"' && invocation[index + 1] === '"') {
        current += '"'
        index += 1
      } else current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === "$" && invocation[index + 1] === "(") throw new Error("Verification command contains a shell operator")
    if (/[|;&<>`]/u.test(character)) throw new Error("Verification command contains a shell operator")
    if (/\s/u.test(character)) {
      if (current !== "") { parts.push(current); current = "" }
      continue
    }
    current += character
  }
  if (quote !== null) throw new Error("Verification command contains an unterminated quote")
  if (current !== "") parts.push(current)
  return parts
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function digest(text: string): string { return createHash("sha256").update(text).digest("hex") }
function truncate(text: string, maximum: number): string { return text.length <= maximum ? text : text.slice(0, maximum) }

async function git(directory: string, argumentsList: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...argumentsList], {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000, windowsHide: true,
  })
  return stdout.trim()
}
