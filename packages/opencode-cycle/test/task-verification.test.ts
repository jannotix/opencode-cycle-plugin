import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseVerificationCommand, runTaskVerification } from "../src/orchestration/task-verification.js"
import type { ArchitecturePlanInput } from "../src/client.js"

test("deterministic task verification records passed commands with bounded digests", async () => {
  const repository = await createRepository()
  try {
    const baseRevision = await git(repository, ["rev-parse", "HEAD"])
    await writeFile(join(repository, "feature.txt"), "complete\n")
    await git(repository, ["add", "."])
    await git(repository, ["commit", "-m", "candidate"])
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

test("deterministic task verification fails on non-zero exit, timeout and revision mismatch", async () => {
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

    const timeout = await runTaskVerification({
      baseRevision: revision,
      changedPaths: [],
      directory: repository,
      revision,
      task: task(['node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000)"']),
      timeoutMillis: 50,
    })
    expect(timeout.passed).toBe(false)
    expect(timeout.commands[0]?.status).toBe("timeout")

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
    await git(repository, ["add", "."])
    await git(repository, ["commit", "-m", "candidate"])
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

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "opencode-cycle-task-verification-"))
  for (const argumentsList of [
    ["init"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test User"],
    ["config", "core.autocrlf", "false"],
  ]) {
    await git(repository, argumentsList)
  }
  await writeFile(join(repository, "feature.txt"), "base\n")
  await git(repository, ["add", "."])
  await git(repository, ["commit", "-m", "base"])
  return repository
}

function git(directory: string, argumentsList: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", directory, ...argumentsList], { encoding: "utf8" }, (error, stdout) => {
      if (error === null) resolve(stdout.trim())
      else reject(error)
    })
  })
}
