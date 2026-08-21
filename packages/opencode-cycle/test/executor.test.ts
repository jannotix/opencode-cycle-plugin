import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ArchitecturePlanInput } from "../src/client.js"
import { runExecutionPlan } from "../src/orchestration/executor.js"

test("executor submits authorized scoped changes and never closes the task itself", async () => {
  const repository = await createRepository()
  const calls: unknown[] = []
  try {
    const results = await runExecutionPlan(
      client(async (directory) => writeFile(join(directory, "feature.txt"), "complete\n"), calls) as never,
      {
        directory: repository,
        model: "provider/model",
        originalRequest: "Implement the complete feature.",
        parentSessionId: "parent",
        plan: plan("feature.txt"),
      },
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe("submitted")
    expect(results[0]?.changedPaths).toEqual(["feature.txt"])
    expect(await git(repository, ["status", "--porcelain"])).toBe("")
    expect(await git(repository, ["rev-list", "--count", "HEAD"])).toBe("2")
    expect(JSON.stringify(calls)).toContain("Cycle Executor")
    expect(JSON.stringify(calls)).toContain("Implement the complete feature.")
    const promptCall = calls.find(
      (call): call is { prompt: { body: { parts: { text: string }[] } } } =>
        typeof call === "object" && call !== null && "prompt" in call,
    )
    const prompt = promptCall?.prompt.body.parts[0]?.text ?? ""
    expect(prompt).toContain("Do not call cycle_control, cycle_role, or goal operations")
    expect(prompt).toContain("Workflow governance runs outside this executor session")
    expect(prompt).toContain("Never return completed")
    expect(prompt).toContain("Assigned task")
    expect(prompt).not.toContain("Architecture context")
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("executor fails closed when a task writes outside its authorized scope", async () => {
  const repository = await createRepository()
  try {
    await expect(
      runExecutionPlan(
        client(async (directory) => writeFile(join(directory, "unauthorized.txt"), "change\n"), []) as never,
        {
          directory: repository,
          model: null,
          originalRequest: "Implement the complete feature.",
          parentSessionId: "parent",
          plan: plan("src"),
        },
      ),
    ).rejects.toThrow("unauthorized paths")
    expect(await git(repository, ["rev-list", "--count", "HEAD"])).toBe("1")
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("executor rejects self-completed receipts", async () => {
  const repository = await createRepository()
  try {
    await expect(
      runExecutionPlan(
        client(
          async () => {},
          [],
          'Verification passed.\n```json\n{"status":"completed","summary":"Task completed."}\n```',
        ) as never,
        {
          directory: repository,
          model: null,
          originalRequest: "Verify the feature.",
          parentSessionId: "parent",
          plan: plan("feature.txt"),
        },
      ),
    ).rejects.toThrow("invalid status")
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("executor accepts one terminal submitted receipt after narrative output", async () => {
  const repository = await createRepository()
  try {
    const results = await runExecutionPlan(
      client(
        async () => {},
        [],
        'Ready for review.\n```json\n{"status":"submitted","summary":"Task submitted."}\n```',
      ) as never,
      {
        directory: repository,
        model: null,
        originalRequest: "Verify the feature.",
        parentSessionId: "parent",
        plan: plan("feature.txt"),
      },
    )

    expect(results[0]?.status).toBe("submitted")
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

for (const status of ["blocked", "plan_defect"] as const) {
  test(`executor never checkpoints a ${status} result`, async () => {
    const repository = await createRepository()
    try {
      const results = await runExecutionPlan(
        client(
          async (directory) => writeFile(join(directory, "feature.txt"), `${status}\n`),
          [],
          JSON.stringify({ status, summary: `${status} evidence` }),
        ) as never,
        {
          directory: repository,
          model: null,
          originalRequest: "Implement the complete feature.",
          parentSessionId: "parent",
          plan: plan("feature.txt"),
        },
      )

      expect(results[0]?.status).toBe(status)
      expect(await git(repository, ["rev-list", "--count", "HEAD"])).toBe("1")
      expect(await git(repository, ["status", "--porcelain"])).toContain("feature.txt")
    } finally {
      await rm(repository, { force: true, recursive: true })
    }
  }, { timeout: 30_000 })
}

test("disjoint same-level tasks run in isolated worktrees and merge onto the source", async () => {
  const repository = await createRepository()
  const directories: string[] = []
  try {
    const results = await runExecutionPlan(
      {
        session: {
          async create() {
            return { data: { id: crypto.randomUUID() } }
          },
          async prompt(options: {
            body: { parts: { text: string }[] }
            query: { directory: string }
          }) {
            directories.push(options.query.directory)
            const text = options.body.parts[0]?.text ?? ""
            const file = text.includes("alpha.txt") ? "alpha.txt" : "beta.txt"
            await writeFile(join(options.query.directory, file), "complete\n")
            return {
              data: {
                parts: [{ text: '{"status":"submitted","summary":"Task submitted."}', type: "text" }],
              },
            }
          },
        },
      } as never,
      {
        directory: repository,
        finalizeTask: async (_task, result) => ({ ...result, status: "completed" }),
        model: null,
        originalRequest: "Implement independent files.",
        parentSessionId: "parent",
        plan: twoTaskPlan(["alpha.txt"], ["beta.txt"]),
      },
    )

    expect(results).toHaveLength(2)
    expect(results.every((result) => result.status === "completed")).toBe(true)
    expect(directories).toHaveLength(2)
    expect(directories.every((directory) => directory !== repository)).toBe(true)
    expect(await git(repository, ["show", "HEAD:alpha.txt"])).toBe("complete")
    expect(await git(repository, ["show", "HEAD:beta.txt"])).toBe("complete")
    expect(await git(repository, ["status", "--porcelain"])).toBe("")
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("overlapping write scopes stay sequential on the source worktree", async () => {
  const repository = await createRepository()
  const directories: string[] = []
  try {
    const results = await runExecutionPlan(
      {
        session: {
          async create() {
            return { data: { id: crypto.randomUUID() } }
          },
          async prompt(options: { query: { directory: string } }) {
            directories.push(options.query.directory)
            await writeFile(join(options.query.directory, "tracked.txt"), "updated\n")
            return {
              data: {
                parts: [{ text: '{"status":"submitted","summary":"Task submitted."}', type: "text" }],
              },
            }
          },
        },
      } as never,
      {
        directory: repository,
        finalizeTask: async (_task, result) => ({ ...result, status: "completed" }),
        model: null,
        originalRequest: "Implement overlapping files.",
        parentSessionId: "parent",
        plan: twoTaskPlan(["tracked.txt"], ["tracked.txt"]),
      },
    )

    expect(results).toHaveLength(2)
    expect(results.every((result) => result.status === "completed")).toBe(true)
    expect(directories).toEqual([repository, repository])
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("executor rejects ambiguous fenced receipts", async () => {
  const repository = await createRepository()
  try {
    await expect(
      runExecutionPlan(
        client(
          async () => {},
          [],
          '```json\n{"status":"blocked","summary":"First."}\n```\n```json\n{"status":"completed","summary":"Second."}\n```',
        ) as never,
        {
          directory: repository,
          model: null,
          originalRequest: "Verify the feature.",
          parentSessionId: "parent",
          plan: plan("feature.txt"),
        },
      ),
    ).rejects.toThrow("one valid JSON object")
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("submitted task alone does not advance dependent work without finalization", async () => {
  const repository = await createRepository()
  const directories: string[] = []
  try {
    const results = await runExecutionPlan(
      {
        session: {
          async create() {
            return { data: { id: crypto.randomUUID() } }
          },
          async prompt(options: { query: { directory: string } }) {
            directories.push(options.query.directory)
            await writeFile(join(options.query.directory, "alpha.txt"), "submitted\n")
            return {
              data: {
                parts: [{ text: '{"status":"submitted","summary":"Task submitted."}', type: "text" }],
              },
            }
          },
        },
      } as never,
      {
        directory: repository,
        model: null,
        originalRequest: "Implement dependent files.",
        parentSessionId: "parent",
        plan: dependentTaskPlan(),
      },
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe("submitted")
    expect(directories).toEqual([repository])
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

function client(
  action: (directory: string) => Promise<void>,
  calls: unknown[],
  output = '{"status":"submitted","summary":"Task submitted."}',
) {
  return {
    session: {
      async create(options: { query: { directory: string } }) {
        calls.push({ create: options })
        return { data: { id: "executor-session" } }
      },
      async prompt(options: { query: { directory: string } }) {
        calls.push({ prompt: options })
        await action(options.query.directory)
        return {
          data: {
            parts: [{ text: output, type: "text" }],
          },
        }
      },
    },
  }
}

function dependentTaskPlan(): ArchitecturePlanInput {
  const base = twoTaskPlan(["alpha.txt"], ["beta.txt"])
  const first = base.tasks[0]
  const second = base.tasks[1]
  if (first === undefined || second === undefined) throw new Error("Invalid fixture")
  return {
    ...base,
    tasks: [
      first,
      {
        ...second,
        dependencies: [first.id],
      },
    ],
  }
}

function twoTaskPlan(
  firstScope: readonly string[],
  secondScope: readonly string[],
): ArchitecturePlanInput {
  return {
    assumptions: [],
    integration_checks: ["Run integration verification."],
    request_digest: "a".repeat(64),
    requirements: [
      {
        acceptance_criteria: ["Feature works."],
        id: "REQ-1",
        statement: "Implement the feature.",
      },
    ],
    risks: [],
    tasks: [
      {
        acceptance_criteria: ["Task works."],
        dependencies: [],
        id: "019ff5e2-0439-7030-8a05-0a91b3ed55e2",
        objective: "Implement the first bounded task.",
        requirement_ids: ["REQ-1"],
        title: "Implement alpha",
        verification_commands: ["project-test"],
        write_scopes: [...firstScope],
      },
      {
        acceptance_criteria: ["Task works."],
        dependencies: [],
        id: "019ff5e2-0439-7030-8a05-0a91b3ed55e3",
        objective: "Implement the second bounded task.",
        requirement_ids: ["REQ-1"],
        title: "Implement beta",
        verification_commands: ["project-test"],
        write_scopes: [...secondScope],
      },
    ],
  }
}

function plan(scope: string): ArchitecturePlanInput {
  return {
    assumptions: [],
    integration_checks: ["Run integration verification."],
    request_digest: "a".repeat(64),
    requirements: [
      {
        acceptance_criteria: ["Feature works."],
        id: "REQ-1",
        statement: "Implement the feature.",
      },
    ],
    risks: [],
    tasks: [
      {
        acceptance_criteria: ["Task works."],
        dependencies: [],
        id: "019ff5e2-0439-7030-8a05-0a91b3ed55e2",
        objective: "Implement the bounded task.",
        requirement_ids: ["REQ-1"],
        title: "Implement feature",
        verification_commands: ["project-test"],
        write_scopes: [scope],
      },
    ],
  }
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "opencode-cycle-executor-"))
  for (const argumentsList of [
    ["init"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test User"],
    ["config", "core.hooksPath", ".git/hooks"],
    ["config", "core.autocrlf", "false"],
  ]) {
    await git(repository, argumentsList)
  }
  await writeFile(join(repository, "tracked.txt"), "base\n")
  await git(repository, ["add", "tracked.txt"])
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
