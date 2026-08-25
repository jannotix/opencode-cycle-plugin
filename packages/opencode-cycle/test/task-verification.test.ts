import { expect, mock, test } from "bun:test"
import { execFile, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ArchitecturePlanInput } from "../src/client.js"
import type { WindowsVerificationTreeAdapter } from "../src/orchestration/task-verification-windows.js"

let windowsTestRoot: {
  readonly parentPid: number
  readonly pid: number
  readonly startedAtUnixMillis: number
} | undefined
const windowsTestAdapter: WindowsVerificationTreeAdapter = {
  async captureRoot(input) {
    windowsTestRoot = {
      parentPid: process.pid,
      pid: input.rootPid,
      startedAtUnixMillis: input.spawnedAtUnixMillis,
    }
    return windowsTestRoot
  },
  async snapshot() {
    return {
      inaccessible: [],
      instances: windowsTestRoot !== undefined && processAlive(windowsTestRoot.pid)
        ? [windowsTestRoot]
        : [],
      observedAtUnixMillis: Date.now(),
    }
  },
  async terminate(root) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
    const result = spawnSync(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(root.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    )
    return { exitCode: result.status ?? 1, status: "delivered" }
  },
}

mock.module("../src/orchestration/task-verification-windows.js", () => ({
  realWindowsVerificationTreeAdapter: () => windowsTestAdapter,
}))
const TaskVerificationModule = await import("../src/orchestration/task-verification.js")
const { parseVerificationCommand, runTaskVerification } = TaskVerificationModule

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

test("Windows tree cleanup rejects taskkill failure, delivery errors and surviving descendants", async () => {
  const createTracker = (TaskVerificationModule as Record<string, unknown>)
    .createWindowsVerificationOwnershipTracker
  expect(createTracker).toBeFunction()
  if (typeof createTracker !== "function") return
  const create = createTracker as (input: Record<string, unknown>) => {
    cleanup(exited: Promise<number>): Promise<Record<string, number>>
    observe(): Promise<void>
  }
  const root = { parentPid: 1, pid: 100, startedAtUnixMillis: 1_000 }
  const observation = { inaccessible: [], instances: [root], observedAtUnixMillis: 2_000 }

  const nonzero = create({
    adapter: {
      captureRoot: async () => root,
      snapshot: async () => observation,
      terminate: async () => ({ exitCode: 5, status: "delivered" }),
    },
    root,
  })
  await nonzero.observe()
  await expect(nonzero.cleanup(Promise.resolve(0))).rejects.toThrow("taskkill")

  const delivery = create({
    adapter: {
      captureRoot: async () => root,
      snapshot: async () => observation,
      terminate: async () => { throw new Error("delivery") },
    },
    root,
  })
  await delivery.observe()
  await expect(delivery.cleanup(Promise.resolve(0))).rejects.toThrow("delivery")

  let survivorNow = 0
  const survivor = create({
    adapter: {
      captureRoot: async () => root,
      snapshot: async () => observation,
      terminate: async () => ({ exitCode: 0, status: "delivered" }),
    },
    root,
    now: () => { survivorNow += 1_000; return survivorNow },
    sleep: async () => undefined,
  })
  await survivor.observe()
  await expect(survivor.cleanup(Promise.resolve(0))).rejects.toThrow("survived")
})

test("Windows ownership tracking rejects PID reuse, root-gone survivors and access failures", async () => {
  const createTracker = (TaskVerificationModule as Record<string, unknown>)
    .createWindowsVerificationOwnershipTracker
  expect(createTracker).toBeFunction()
  if (typeof createTracker !== "function") return
  const create = createTracker as (input: Record<string, unknown>) => {
    cleanup(exited: Promise<number>): Promise<Record<string, number>>
    observe(): Promise<void>
  }
  const root = { parentPid: 1, pid: 100, startedAtUnixMillis: 1_000 }
  const descendant = { parentPid: 100, pid: 101, startedAtUnixMillis: 1_001 }
  const reusedRoot = { parentPid: 2, pid: 100, startedAtUnixMillis: 2_000 }
  const observation = (
    instances: readonly Record<string, number>[],
    inaccessible: readonly Record<string, number>[] = [],
  ) => ({ inaccessible, instances, observedAtUnixMillis: 3_000 })

  const reuseSnapshots = [
    observation([root, descendant]),
    observation([reusedRoot, descendant]),
    observation([reusedRoot]),
  ]
  const reuseTerminations: number[] = []
  const reuse = create({
    adapter: {
      captureRoot: async () => root,
      snapshot: async () => reuseSnapshots.shift() ?? observation([reusedRoot]),
      terminate: async (instance: { pid: number }) => {
        reuseTerminations.push(instance.pid)
        return { exitCode: 0, status: "delivered" }
      },
    },
    root,
  })
  await reuse.observe()
  const reuseSummary = await reuse.cleanup(Promise.resolve(0))
  expect(reuseTerminations).toEqual([descendant.pid])
  expect(reuseSummary).toMatchObject({ delivered: 1, reused: 1, survivors: 0 })

  const goneSnapshots = [
    observation([root, descendant]),
    observation([descendant]),
    observation([]),
  ]
  const goneTerminations: number[] = []
  const gone = create({
    adapter: {
      captureRoot: async () => root,
      snapshot: async () => goneSnapshots.shift() ?? observation([]),
      terminate: async (instance: { pid: number }) => {
        goneTerminations.push(instance.pid)
        return { exitCode: 0, status: "delivered" }
      },
    },
    root,
  })
  await gone.observe()
  const goneSummary = await gone.cleanup(Promise.resolve(0))
  expect(goneTerminations).toEqual([descendant.pid])
  expect(goneSummary).toMatchObject({ absent: 1, delivered: 1, survivors: 0 })

  const inaccessible = create({
    adapter: {
      captureRoot: async () => root,
      snapshot: async () => observation([root], [{ parentPid: root.pid, pid: 102 }]),
      terminate: async () => ({ exitCode: 0, status: "delivered" }),
    },
    root,
  })
  await expect(inaccessible.observe()).rejects.toThrow("access")

  const failedSnapshot = create({
    adapter: {
      captureRoot: async () => root,
      snapshot: async () => { throw new Error("snapshot access failed") },
      terminate: async () => ({ exitCode: 0, status: "delivered" }),
    },
    root,
  })
  await expect(failedSnapshot.observe()).rejects.toThrow("snapshot access failed")
})

test("real Windows adapter refuses to terminate a reused live PID identity", async () => {
  if (process.platform !== "win32") return
  const moduleUrl = new URL("../src/orchestration/task-verification-windows.ts", import.meta.url).href
  const source = `
const module = await import(${JSON.stringify(moduleUrl)})
const adapter = module.realWindowsVerificationTreeAdapter()
const current = await adapter.captureRoot({ rootPid: process.pid, spawnedAtUnixMillis: 0 })
const result = await adapter.terminate({
  ...current,
  startedAtUnixMillis: current.startedAtUnixMillis + 1,
})
process.kill(process.pid, 0)
process.stdout.write(JSON.stringify(result))
`
  const child = Bun.spawn([process.execPath, "-e", source], {
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  expect(JSON.parse(stdout)).toMatchObject({ status: "reused" })
})

test("real Windows tracker cleans an exact descendant after its root exits", async () => {
  if (process.platform !== "win32") return
  const windowsUrl = new URL("../src/orchestration/task-verification-windows.ts", import.meta.url).href
  const verificationUrl = new URL("../src/orchestration/task-verification.ts", import.meta.url).href
  const source = `
const { spawn } = await import("node:child_process")
const { mkdtemp, readFile, rm } = await import("node:fs/promises")
const { join } = await import("node:path")
const { tmpdir } = await import("node:os")
const windows = await import(${JSON.stringify(windowsUrl)})
const verification = await import(${JSON.stringify(verificationUrl)})
const temporary = await mkdtemp(join(tmpdir(), "cycle-root-gone-"))
const pidFile = join(temporary, "tree.json")
const rootSource = [
  "const {spawn}=require('node:child_process')",
  "const {writeFileSync}=require('node:fs')",
  "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})",
  "child.unref()",
  "writeFileSync(process.argv[1],JSON.stringify({descendant:child.pid}))",
  "setTimeout(()=>process.exit(0),1500)",
].join(";")
const node = Bun.which("node")
const spawnedAtUnixMillis = Date.now()
const root = spawn(node, ["-e", rootSource, pidFile], { detached: true, stdio: "ignore" })
const exited = new Promise((resolve, reject) => {
  root.once("error", reject)
  root.once("exit", (code) => resolve(code ?? 1))
})
try {
  const adapter = windows.realWindowsVerificationTreeAdapter()
  const identity = await adapter.captureRoot({ rootPid: root.pid, spawnedAtUnixMillis })
  const tracker = verification.createWindowsVerificationOwnershipTracker({ adapter, root: identity })
  await tracker.observe()
  tracker.start()
  let descendant
  for (let attempt = 0; attempt < 100; attempt += 1) {
    descendant = await readFile(pidFile, "utf8").then((value) => JSON.parse(value).descendant, () => undefined)
    if (Number.isSafeInteger(descendant)) break
    await Bun.sleep(25)
  }
  if (!Number.isSafeInteger(descendant)) throw new Error("descendant")
  const rootExit = await exited
  const summary = await tracker.cleanup(Promise.resolve(rootExit))
  let descendantAlive = true
  try { process.kill(descendant, 0) } catch { descendantAlive = false }
  process.stdout.write(JSON.stringify({ descendantAlive, rootExit, summary }))
} finally {
  await rm(temporary, { force: true, recursive: true })
}
`
  const child = Bun.spawn([process.execPath, "-e", source], {
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  expect(JSON.parse(stdout)).toMatchObject({
    descendantAlive: false,
    rootExit: 0,
    summary: { absent: 1, delivered: 1, survivors: 0 },
  })
}, 20_000)

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
