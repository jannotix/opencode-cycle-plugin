import { expect, mock, test } from "bun:test"
import { execFile, spawn as spawnChildProcess, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ArchitecturePlanInput } from "../src/client.js"
let windowsTerminationRequests = 0

mock.module("../src/orchestration/task-verification-windows.js", () => ({
  spawnWindowsVerificationJobHost(input: {
    readonly args: readonly string[]
    readonly directory: string
    readonly environment: NodeJS.ProcessEnv
    readonly tool: string
  }) {
    const child = spawnChildProcess(input.tool, [...input.args], {
      cwd: input.directory,
      detached: true,
      env: input.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    if (child.pid === undefined || child.stdout === null || child.stderr === null) {
      throw new Error("test Job host failed to start")
    }
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
    return {
      exited,
      pid: child.pid,
      stderr: child.stderr,
      stdout: child.stdout,
      async terminate() {
        if (child.exitCode !== null || child.signalCode !== null) return
        windowsTerminationRequests += 1
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
        const result = spawnSync(
          join(systemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        )
        if (result.status !== 0 && processAlive(child.pid as number)) {
          throw new Error("test Job termination failed")
        }
        await exited
      },
    }
  },
}))
const TaskVerificationModule = await import("../src/orchestration/task-verification.js")
const { parseVerificationCommand } = TaskVerificationModule
type VerificationInput = Omit<
  Parameters<typeof TaskVerificationModule.runTaskVerification>[0],
  "verificationHostPath"
> & { readonly verificationHostPath?: string }
const runTaskVerification = (input: VerificationInput) =>
  TaskVerificationModule.runTaskVerification({
    ...input,
    verificationHostPath: input.verificationHostPath ?? process.execPath,
  })

test("deterministic task verification records passed commands with bounded digests", async () => {
  const repository = await createRepository()
  try {
    const baseRevision = await git(repository, ["rev-parse", "HEAD"])
    await writeFile(join(repository, "feature.txt"), "complete\n")
    await git(repository, ["commit", "-am", "candidate"])
    const revision = await git(repository, ["rev-parse", "HEAD"])

    const receipt = await runTaskVerification({
      baseRevision,
      changedPaths: ["feature.txt"],
      directory: repository,
      revision,
      task: task(['node -e "process.stdout.write(\'ok\')"']),
    })

    expect(receipt.passed).toBe(true)
    expect(receipt.commands).toHaveLength(1)
    expect(receipt.commands[0]).toMatchObject({
      exitCode: 0,
      invocation: 'node -e "process.stdout.write(\'ok\')"',
      status: "passed",
      tool: "node",
    })
    expect(receipt.commands[0]?.outputDigest).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("deterministic task verification fails on non-zero exit and revision mismatch", async () => {
  const repository = await createRepository()
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])

    const failed = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task(['node -e "process.exit(7)"']),
    })
    expect(failed.passed).toBe(false)
    expect(failed.commands[0]?.exitCode).toBe(7)
    expect(failed.commands[0]?.status).toBe("failed")

    const mismatch = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision: "1".repeat(40),
      task: task(['node -e "process.exit(0)"']),
    })
    expect(mismatch).toMatchObject({ commands: [], passed: false })
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("deterministic task verification binds base revision and changed paths", async () => {
  const repository = await createRepository()
  try {
    const baseRevision = await git(repository, ["rev-parse", "HEAD"])
    await writeFile(join(repository, "feature.txt"), "complete\n")
    await git(repository, ["commit", "-am", "candidate"])
    const revision = await git(repository, ["rev-parse", "HEAD"])

    const wrongBase = await runTaskVerification({
      baseRevision: "0".repeat(40),
      changedPaths: ["feature.txt"],
      directory: repository,
      revision,
      task: task(['node -e "process.exit(0)"']),
    })
    expect(wrongBase).toMatchObject({ commands: [], passed: false })

    const wrongPaths = await runTaskVerification({
      baseRevision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task(['node -e "process.exit(0)"']),
    })
    expect(wrongPaths).toMatchObject({ commands: [], passed: false })

    const unauthorizedPaths = await runTaskVerification({
      baseRevision,
      changedPaths: ["feature.txt"],
      directory: repository,
      revision,
      task: { ...task(['node -e "process.exit(0)"']), write_scopes: ["src/"] },
    })
    expect(unauthorizedPaths).toMatchObject({ commands: [], passed: false })
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("deterministic task verification rejects shells, git and shell operators before execution", async () => {
  for (const command of [
    "git status",
    "bash -lc test",
    "pwsh -Command test",
    "rm feature.txt",
    "shutdown now",
    "node deploy",
    "node -e ok && echo bad",
    "node -e ok > out",
  ]) {
    expect(() => parseVerificationCommand(command)).toThrow()
  }
  const repository = await createRepository()
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const receipt = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task(["git status"]),
    })
    expect(receipt.passed).toBe(false)
    expect(receipt.commands[0]).toMatchObject({ exitCode: null, status: "failed", tool: "invalid" })
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("deterministic task verification uses a minimal cross-platform environment", async () => {
  const repository = await createRepository()
  const secretName = "CYCLE_TASK_VERIFICATION_TEST_SECRET"
  const previous = process.env[secretName]
  process.env[secretName] = "must-not-leak"
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const receipt = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task([
        `node -e "if(process.env.${secretName}||process.env.CI!=='true'||!process.env.PATH||!(process.env.TEMP||process.env.TMP||process.env.TMPDIR)){process.exit(9)}"`,
      ]),
    })
    expect(receipt.passed).toBe(true)
  } finally {
    if (previous === undefined) delete process.env[secretName]
    else process.env[secretName] = previous
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("deterministic task verification fails closed when command output exceeds its bound", async () => {
  const repository = await createRepository()
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const receipt = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task(['node -e "process.stdout.write(\'x\'.repeat(100000))"']),
    })
    expect(receipt.passed).toBe(false)
    expect(receipt.commands[0]?.status).toBe("failed")
    expect(receipt.commands[0]?.outputPreview.length).toBeLessThanOrEqual(4_096)
    expect(receipt.commands[0]?.outputDigest).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("deterministic task verification rejects post-command tracked, untracked and HEAD mutations", async () => {
  const repository = await createRepository({
    "mutate-head.cjs": `const {spawnSync}=require("node:child_process");
const env={...process.env,GIT_AUTHOR_NAME:"Verifier",GIT_AUTHOR_EMAIL:"verify@example.invalid",GIT_COMMITTER_NAME:"Verifier",GIT_COMMITTER_EMAIL:"verify@example.invalid"};
const result=spawnSync("git",["commit","--allow-empty","-m","forbidden"],{env,stdio:"ignore"});
process.exit(result.status ?? 1);
`,
  })
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    for (const [command, expected] of [
      ['node -e "require(\'node:fs\').writeFileSync(\'feature.txt\',\'mutated\\n\')"', "uncommitted"],
      ['node -e "require(\'node:fs\').writeFileSync(\'untracked.txt\',\'created\\n\')"', "uncommitted"],
      ["node mutate-head.cjs", "current worktree revision"],
    ] as const) {
      await git(repository, ["reset", "--hard", revision])
      await git(repository, ["clean", "-fd"])
      const receipt = await runTaskVerification({
        baseRevision: revision,
        changedPaths: [],
        directory: repository,
        revision,
        task: task([command]),
      })
      expect(receipt.passed).toBe(false)
      expect(receipt.commands[0]?.status).toBe("passed")
      expect(receipt.bindingError).toContain(expected)
    }
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("timeout terminates the verification process tree", async () => {
  const pidFile = join(tmpdir(), `cycle-verifier-timeout-${crypto.randomUUID()}.pid`)
  const repository = await createRepository({ "process-tree.cjs": processTreeFixture(false) })
  let descendantPid: number | undefined
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const receipt = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task([`node process-tree.cjs "${pidFile}"`]),
      timeoutMillis: 500,
    })
    descendantPid = Number(await readFile(pidFile, "utf8"))
    expect(receipt.commands[0]?.status).toBe("timeout")
    await expectProcessExit(descendantPid)
  } finally {
    if (descendantPid !== undefined) killProcess(descendantPid)
    await rm(pidFile, { force: true })
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("abort terminates the verification process tree and propagates cancellation", async () => {
  const pidFile = join(tmpdir(), `cycle-verifier-abort-${crypto.randomUUID()}.pid`)
  const repository = await createRepository({ "process-tree.cjs": processTreeFixture(false) })
  const controller = new AbortController()
  let descendantPid: number | undefined
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const verification = runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      signal: controller.signal,
      task: task([`node process-tree.cjs "${pidFile}"`]),
    })
    descendantPid = await waitForPid(pidFile)
    controller.abort()
    await expect(verification).rejects.toThrow()
    await expectProcessExit(descendantPid)
  } finally {
    if (descendantPid !== undefined) killProcess(descendantPid)
    await rm(pidFile, { force: true })
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("verification process-group containment leaves no background descendant after success", async () => {
  if (process.platform === "win32") return
  const pidFile = join(tmpdir(), `cycle-verifier-success-${crypto.randomUUID()}.pid`)
  const repository = await createRepository({ "process-tree.cjs": processTreeFixture(false, true) })
  let descendantPid: number | undefined
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const receipt = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task([`node process-tree.cjs "${pidFile}"`]),
    })
    descendantPid = Number(await readFile(pidFile, "utf8"))
    expect(processAlive(descendantPid)).toBe(false)
    expect(receipt.passed).toBe(true)
    await expectProcessExit(descendantPid)
  } finally {
    if (descendantPid !== undefined) killProcess(descendantPid)
    await rm(pidFile, { force: true })
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("output-limit termination kills the verification process tree", async () => {
  const pidFile = join(tmpdir(), `cycle-verifier-output-${crypto.randomUUID()}.pid`)
  const repository = await createRepository({ "process-tree.cjs": processTreeFixture(true) })
  let descendantPid: number | undefined
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const receipt = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task([`node process-tree.cjs "${pidFile}"`]),
    })
    descendantPid = Number(await readFile(pidFile, "utf8"))
    expect(receipt.passed).toBe(false)
    expect(receipt.commands[0]?.status).toBe("failed")
    await expectProcessExit(descendantPid)
  } finally {
    if (descendantPid !== undefined) killProcess(descendantPid)
    await rm(pidFile, { force: true })
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("verification child errors reject instead of impersonating process exit", async () => {
  const createExit = (TaskVerificationModule as Record<string, unknown>)
    .createVerificationProcessExitPromise
  expect(createExit).toBeFunction()
  if (typeof createExit !== "function") return
  const events = new EventEmitter()
  const exited = (createExit as (events: EventEmitter) => Promise<number>)(events)
  const failure = new Error("kill delivery failed")
  events.emit("error", failure)
  events.emit("exit", 0)
  await expect(exited).rejects.toBe(failure)
})

test("production Windows verification uses the native Job host without PID sampling", async () => {
  const [typescriptSource, nativeSource] = await Promise.all([
    readFile(new URL("../src/orchestration/task-verification-windows.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../crates/workflowd/src/verification_job.rs", import.meta.url), "utf8"),
  ])
  expect(typescriptSource).toContain("--verification-job-host")
  expect(typescriptSource).not.toContain("taskkill")
  expect(typescriptSource).not.toContain("Toolhelp")
  expect(nativeSource).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE")
  expect(nativeSource).toContain("CREATE_SUSPENDED")
  expect(nativeSource.indexOf("AssignProcessToJobObject")).toBeLessThan(
    nativeSource.indexOf("ResumeThread"),
  )
})

test("Windows timeout and output-limit paths deliver Job termination control", async () => {
  if (process.platform !== "win32") return
  const before = windowsTerminationRequests
  const repository = await createRepository()
  try {
    const revision = await git(repository, ["rev-parse", "HEAD"])
    const timeoutReceipt = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task(['node -e "setInterval(()=>{},1000)"']),
      timeoutMillis: 25,
    })
    expect(timeoutReceipt.commands[0]?.status).toBe("timeout")
    expect(windowsTerminationRequests).toBeGreaterThan(before)
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

function task(verificationCommands: readonly string[]): ArchitecturePlanInput["tasks"][number] {
  return {
    acceptance_criteria: ["Task works."],
    dependencies: [],
    id: crypto.randomUUID(),
    objective: "Implement the bounded task.",
    requirement_ids: ["REQ-1"],
    title: "Implement feature",
    verification_commands: verificationCommands,
    write_scopes: ["feature.txt"],
  }
}

async function createRepository(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "opencode-cycle-task-verification-"))
  await git(repository, ["init"])
  await writeFile(join(repository, "feature.txt"), "base\n")
  await Promise.all(
    Object.entries(files).map(([path, contents]) => writeFile(join(repository, path), contents)),
  )
  await git(repository, ["add", "."])
  await git(repository, ["commit", "-m", "base"])
  return repository
}

function git(directory: string, argumentsList: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [
      "-C",
      directory,
      "-c",
      "core.autocrlf=false",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Test User",
      ...argumentsList,
    ], { encoding: "utf8" }, (error, stdout) => {
      if (error === null) resolve(stdout.trim())
      else reject(error)
    })
  })
}

function processTreeFixture(outputLimit: boolean, exitAfterSpawn = false): string {
  return `const {spawn}=require("node:child_process");
const {writeFileSync}=require("node:fs");
const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
writeFileSync(process.argv[2],String(child.pid));
${outputLimit ? 'process.stdout.write("x".repeat(100000));' : ""}
${exitAfterSpawn ? "process.exit(0);" : "setInterval(()=>{},1000);"}
`
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => "")
    const pid = Number(value)
    if (Number.isSafeInteger(pid) && pid > 0) return pid
    await Bun.sleep(25)
  }
  throw new Error("Verification descendant PID was not recorded")
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await Bun.sleep(25)
  }
  expect(processAlive(pid)).toBe(false)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // The process already exited.
  }
}
