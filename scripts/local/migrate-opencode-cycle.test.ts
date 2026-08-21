import { afterEach, expect, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { compareInventories, isRelevantPreReleaseProcess, migrateOpenCodeCycle } from "./migrate-opencode-cycle.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

async function fixture(options: { divergent?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "opencode-cycle-migration-"))
  roots.push(root)
  const oldState = join(root, "old-state")
  const newState = join(root, "new-state")
  const oldInstall = join(root, "old-install")
  const newInstall = join(root, "new-install")
  const plugins = join(root, "plugins")
  const config = join(root, "opencode.json")
  const dist = join(root, "dist")
  const binary = join(root, "workflowd.exe")
  const receipt = join(root, "receipt.json")
  const backup = join(root, "backup.db")
  await Promise.all([
    mkdir(join(oldState, "runtime"), { recursive: true }),
    mkdir(oldInstall, { recursive: true }),
    mkdir(plugins, { recursive: true }),
    mkdir(dist, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(oldState, "control-plane.db"), "database"),
    writeFile(join(oldState, "runtime", "ledger.key"), "key"),
    writeFile(join(dist, "index.js"), "export default async () => ({})\n"),
    writeFile(binary, "binary"),
    writeFile(
      join(plugins, "opencode-workflow.js"),
      "export default async function OpenCodeWorkflowPlugin() {}\n",
    ),
    writeFile(
      config,
      JSON.stringify({
        agent: {
          "WorkFlow Architect": { model: "architect" },
          "WorkFlow Executor": { model: "legacy-executor" },
          "WorkFlow Functional Reviewer": { model: "functional" },
          "WorkFlow Security and Architecture Reviewer": { model: "security" },
          "WorkFlow Arbiter": { model: "arbiter" },
        },
        unrelated: { retain: ["unchanged"], nested: { falseValue: false, number: 7 } },
      }),
    ),
  ])
  if (options.divergent) {
    await mkdir(newState, { recursive: true })
    await writeFile(join(newState, "control-plane.db"), "different")
  }
  return {
    allowTestPaths: true,
    backup,
    backupDatabase: async (_source: string, destination: string) => writeFile(destination, "sqlite backup"),
    binary,
    config,
    dist,
    newInstall,
    newState,
    oldInstall,
    oldState,
    plugins,
    receipt,
    root,
    processes: async () => [],
    verify: async () => ({
      doctor: { ledger: "valid", schemaVersion: 17, status: "PASS" },
      health: { protocol_version: 1, schema_version: 17 },
      history: { chain: { status: "valid" }, checkpoints: [{ status: "valid" }] },
    }),
    windowsReparseScan: async () => [],
  }
}

test("migration preserves unrelated config and Cycle model assignments", async () => {
  const input = await fixture()
  await migrateOpenCodeCycle({ ...input, mode: "apply" })
  const config = JSON.parse(await readFile(input.config, "utf8"))
  expect(config.agent["Cycle Executor"]).toEqual({
    model: "zai-coding-plan/glm-5.3",
    reasoningEffort: "max",
  })
  expect(config.unrelated).toEqual({ retain: ["unchanged"], nested: { falseValue: false, number: 7 } })
  expect(config.agent["WorkFlow Executor"]).toBeUndefined()
})

test("migration refuses divergent non-empty destination state", async () => {
  const input = await fixture({ divergent: true })
  await expect(migrateOpenCodeCycle({ ...input, mode: "apply" })).rejects.toThrow(
    "OpenCode Cycle state destination already exists",
  )
})

test("config atomic-write failure restores exact config bytes and keeps source state", async () => {
  const input = await fixture()
  const before = await readFile(input.config)
  await expect(
    migrateOpenCodeCycle({
      ...input,
      mode: "apply",
      faults: { configWrite: async () => { throw new Error("config write failed") } },
    }),
  ).rejects.toThrow("config write failed")
  expect(await readFile(input.config)).toEqual(before)
  expect(await Bun.file(join(input.oldState, "control-plane.db")).exists()).toBe(true)
  expect(await Bun.file(join(input.plugins, "opencode-workflow.js")).exists()).toBe(true)
  expect(await Bun.file(join(input.plugins, "opencode-workflow.js.pre-cycle-backup")).exists()).toBe(false)
})

test("verification failure restores the pre-release loader", async () => {
  const input = await fixture()
  const before = await readFile(input.config)
  await expect(
    migrateOpenCodeCycle({
      ...input,
      mode: "apply",
      verify: async () => {
        throw new Error("verification failed")
      },
    }),
  ).rejects.toThrow("verification failed")
  expect(await readFile(input.config)).toEqual(before)
  expect(await Bun.file(join(input.plugins, "opencode-workflow.js")).exists()).toBe(true)
  expect(await Bun.file(join(input.plugins, "opencode-workflow.js.pre-cycle-backup")).exists()).toBe(false)
})

test("dry-run returns the full plan and writes no files or temporary directories", async () => {
  const input = await fixture()
  const before = await directorySnapshot(input.root)
  const result = await migrateOpenCodeCycle({ ...input, mode: "dry-run" })
  expect(result.plan).toEqual({
    backup: input.backup,
    config: input.config,
    newInstall: input.newInstall,
    newLoader: join(input.plugins, "opencode-cycle.js"),
    newState: input.newState,
    oldInstall: input.oldInstall,
    oldLoader: join(input.plugins, "opencode-workflow.js"),
    oldState: input.oldState,
    receipt: input.receipt,
    steps: [
      "backup",
      "copy-state",
      "activate-state",
      "activate-install",
      "activate-loader",
      "verify",
      "receipt",
    ],
  })
  expect(await directorySnapshot(input.root)).toEqual(before)
})

test("pre-existing Cycle destinations and migration artifacts are never clobbered", async () => {
  for (const [label, path] of Object.entries({
    install: "newInstall",
    loader: "newLoader",
    receipt: "receipt",
    state: "newState",
  })) {
    const input = await fixture()
    const target = path === "newLoader" ? join(input.plugins, "opencode-cycle.js") : input[path as "backup" | "newInstall" | "receipt" | "newState"]
    if (label === "install" || label === "state") await mkdir(target, { recursive: true })
    else await writeFile(target, `user ${label}`)
    const before = label === "install" || label === "state" ? undefined : await readFile(target, "utf8")
    await expect(migrateOpenCodeCycle({ ...input, mode: "apply" })).rejects.toThrow("already exists")
    if (before !== undefined) expect(await readFile(target, "utf8")).toBe(before)
  }
})

test("pre-existing pre-release loader backup name is preserved", async () => {
  const input = await fixture()
  const backup = join(input.plugins, "opencode-workflow.js.pre-cycle-backup")
  await writeFile(backup, "user backup")
  await expect(migrateOpenCodeCycle({ ...input, mode: "apply" })).rejects.toThrow("pre-release loader backup already exists")
  expect(await readFile(backup, "utf8")).toBe("user backup")
})

test("backup failure aborts before state activation and cleans only temporary work", async () => {
  const input = await fixture()
  const before = await directorySnapshot(input.root)
  await expect(
    migrateOpenCodeCycle({ ...input, mode: "apply", faults: { backup: async () => { throw new Error("backup failed") } } }),
  ).rejects.toThrow("backup failed")
  expect(await directorySnapshot(input.root)).toEqual(before)
})

test("SQLite sidecar changes during backup establish the authoritative post-backup inventory", async () => {
  const input = await fixture()
  const sidecar = join(input.oldState, "control-plane.db-shm")
  await writeFile(sidecar, "before backup")
  const result = await migrateOpenCodeCycle({
    ...input,
    mode: "apply",
    backupDatabase: async (_source, destination) => {
      await writeFile(destination, "sqlite backup")
      await writeFile(sidecar, "after backup")
    },
  })
  expect(await readFile(join(input.newState, "control-plane.db-shm"), "utf8")).toBe("after backup")
  expect(result.state).toContainEqual(expect.objectContaining({ kind: "file", path: "control-plane.db-shm", size: 12 }))
})

test("an existing recoverable backup is preserved and a retry uses a unique backup path", async () => {
  const input = await fixture()
  await writeFile(input.backup, "prior recoverable backup")
  const priorAttempt = join(input.root, "backup.attempt-1.db")
  await writeFile(priorAttempt, "prior retry backup")
  let backupDestination = ""
  const result = await migrateOpenCodeCycle({
    ...input,
    mode: "apply",
    backupDatabase: async (_source, destination) => {
      backupDestination = destination
      await writeFile(destination, "retry backup")
    },
  })
  expect(await readFile(input.backup, "utf8")).toBe("prior recoverable backup")
  expect(await readFile(priorAttempt, "utf8")).toBe("prior retry backup")
  expect(result.plan.backup).toBe(join(input.root, "backup.attempt-2.db"))
  expect(backupDestination).not.toBe(input.backup)
  expect(await readFile(result.plan.backup, "utf8")).toBe("retry backup")
})

test("inventory mismatch diagnostics contain only sorted relative metadata", () => {
  const directoryDigest = "1".repeat(64)
  const oldDigest = "2".repeat(64)
  const newDigest = "3".repeat(64)
  expect(compareInventories(
    [
      { kind: "file", path: "runtime/z.db-wal", sha256: oldDigest, size: 10 },
      { kind: "directory", path: "empty", sha256: directoryDigest, size: 0 },
    ],
    [
      { kind: "file", path: "runtime/z.db-wal", sha256: newDigest, size: 12 },
      { kind: "file", path: "added.db-shm", sha256: newDigest, size: 8 },
    ],
  )).toEqual([
    { actual: { kind: "file", path: "added.db-shm", sha256: newDigest, size: 8 }, expected: null, path: "added.db-shm" },
    { actual: null, expected: { kind: "directory", path: "empty", sha256: directoryDigest, size: 0 }, path: "empty" },
    {
      actual: { kind: "file", path: "runtime/z.db-wal", sha256: newDigest, size: 12 },
      expected: { kind: "file", path: "runtime/z.db-wal", sha256: oldDigest, size: 10 },
      path: "runtime/z.db-wal",
    },
  ])
  const entryWithContent = { content: "never expose database content", kind: "file" as const, path: "secret.db", sha256: oldDigest, size: 10 }
  expect(JSON.stringify(compareInventories([entryWithContent], []))).not.toContain(entryWithContent.content)
})

test("loader activation and receipt failures restore config and loader without deleting recovery copies", async () => {
  for (const fault of ["loaderActivation", "receiptPublish"] as const) {
    const input = await fixture()
    const configBefore = await readFile(input.config)
    await expect(
      migrateOpenCodeCycle({
        ...input,
        mode: "apply",
        faults: { [fault]: async () => { throw new Error(`${fault} failed`) } },
      }),
    ).rejects.toThrow(`${fault} failed`)
    expect(await readFile(input.config)).toEqual(configBefore)
    expect(await Bun.file(join(input.plugins, "opencode-workflow.js")).exists()).toBe(true)
    expect(await Bun.file(join(input.plugins, "opencode-workflow.js.pre-cycle-backup")).exists()).toBe(false)
    expect(await Bun.file(join(input.plugins, "opencode-cycle.js")).exists()).toBe(false)
    expect((await lstat(input.newState)).isDirectory()).toBe(true)
    expect((await lstat(input.newInstall)).isDirectory()).toBe(true)
    expect(await Bun.file(input.backup).exists()).toBe(true)
  }
})

test("partial receipt write and no-clobber publish failures leave no receipt residue", async () => {
  for (const fault of ["receiptPartialWrite", "receiptPublish", "receiptParentSync"] as const) {
    const input = await fixture()
    const configBefore = await readFile(input.config)
    await expect(
      migrateOpenCodeCycle({
        ...input,
        mode: "apply",
        faults: { [fault]: async () => { throw new Error(`${fault} failed`) } },
      }),
    ).rejects.toThrow(`${fault} failed`)
    expect(await Bun.file(input.receipt).exists()).toBe(false)
    expect((await readdir(input.root)).some((name) => name.includes("receipt") && name.endsWith(".tmp"))).toBe(false)
    expect(await readFile(input.config)).toEqual(configBefore)
    expect(await Bun.file(join(input.plugins, "opencode-workflow.js")).exists()).toBe(true)
  }
})

test("inventory includes empty directories and rejects reparse-point probes", async () => {
  const input = await fixture()
  await mkdir(join(input.oldState, "empty"))
  const result = await migrateOpenCodeCycle({ ...input, mode: "dry-run" })
  expect(result.state).toContainEqual(expect.objectContaining({ kind: "directory", path: "empty", size: 0 }))
  try {
    await symlink(input.oldState, join(input.oldState, "junction"), "junction")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return
    throw error
  }
  await expect(migrateOpenCodeCycle({ ...input, mode: "dry-run" })).rejects.toThrow("reparse points")
})

test("Windows reparse-point scan indication fails closed", async () => {
  const input = await fixture()
  await expect(migrateOpenCodeCycle({ ...input, mode: "dry-run", windowsReparseScan: async () => [{ attributes: 0x400, path: "opaque" }] })).rejects.toThrow("reparse points")
})

test("each inventory root uses one injected Windows reparse scan", async () => {
  const input = await fixture()
  const roots: string[] = []
  await migrateOpenCodeCycle({ ...input, mode: "dry-run", windowsReparseScan: async (root) => { roots.push(root); return [] } })
  expect(roots).toEqual([input.oldState])
})

test("Windows batch reparse scan accepts an ordinary fixture root", async () => {
  const fixtureInput = await fixture()
  const { windowsReparseScan: _scanner, ...input } = fixtureInput
  await expect(migrateOpenCodeCycle({ ...input, mode: "dry-run" })).resolves.toMatchObject({ dryRun: true })
})

test("malformed doctor or history verification cannot produce a PASS receipt", async () => {
  const input = await fixture()
  await expect(
    migrateOpenCodeCycle({
      ...input,
      mode: "apply",
      verify: async () => ({
        doctor: { ledger: "valid", schemaVersion: 17, status: "PASS" },
        health: { protocol_version: 1, schema_version: 17 },
        history: { chain: { status: "broken" }, checkpoints: [{ status: "valid" }] },
      }),
    }),
  ).rejects.toThrow("Cycle history verification failed")
  expect(await Bun.file(input.receipt).exists()).toBe(false)
})

test("process detection blocks only the pre-release owner and Desktop host", () => {
  const oldInstall = "C:\\Users\\User\\.config\\opencode\\opencode-workflow"
  const oldState = "C:\\Users\\User\\AppData\\Local\\OpenCode WorkFlow"
  expect(isRelevantPreReleaseProcess({ name: "workflowd.exe", executablePath: `${oldInstall}\\bin\\workflowd.exe`, commandLine: null }, oldInstall, oldState)).toBe(true)
  expect(isRelevantPreReleaseProcess({ name: "workflowd.exe", executablePath: "C:\\tools\\workflowd.exe", commandLine: `--data-dir "${oldState}"` }, oldInstall, oldState)).toBe(true)
  expect(isRelevantPreReleaseProcess({ name: "workflowd.exe", executablePath: null, commandLine: `workflowd --data-dir="${oldState}"` }, oldInstall, oldState)).toBe(true)
  expect(isRelevantPreReleaseProcess({ name: "workflowd.exe", executablePath: null, commandLine: `--data-dir C:\\other --data-dir "${oldState}"` }, oldInstall, oldState)).toBe(true)
  expect(isRelevantPreReleaseProcess({ name: "workflowd.exe", executablePath: "C:\\tools\\workflowd.exe", commandLine: "--data-dir C:\\other" }, oldInstall, oldState)).toBe(false)
  expect(isRelevantPreReleaseProcess({ name: "opencode.exe", executablePath: "C:\\OpenCode\\opencode.exe", commandLine: "--plugin opencode-workflow" }, oldInstall, oldState)).toBe(true)
  expect(isRelevantPreReleaseProcess({ name: "opencode.exe", executablePath: "C:\\OpenCode\\opencode.exe", commandLine: "--plugin unrelated" }, oldInstall, oldState)).toBe(false)
})

test("injected relevant process blocks without creating migration artifacts", async () => {
  const input = await fixture()
  const before = await directorySnapshot(input.root)
  await expect(
    migrateOpenCodeCycle({
      ...input,
      mode: "apply",
      processes: async () => [{ name: "workflowd.exe", executablePath: join(input.oldInstall, "bin", "workflowd.exe"), commandLine: null }],
    }),
  ).rejects.toThrow("pre-release owner process")
  expect(await directorySnapshot(input.root)).toEqual(before)
})

async function directorySnapshot(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      result.push(`${entry.isDirectory() ? "d" : "f"}:${path.slice(root.length)}:${entry.isDirectory() ? "" : (await readFile(path)).toString("base64")}`)
      if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(root)
  return result.sort()
}
