import { expect, test } from "bun:test"

import type { ArchitecturePlanInput } from "../src/client.js"
import { parseTaskReview, runTaskReview, type TaskReviewInput } from "../src/orchestration/task-review.js"

test("task review prompt uses original request and verification evidence without executor self-assessment", async () => {
  const input = taskReviewInput()
  let prompt = ""
  const result = await runTaskReview(
    {
      session: {
        async create() {
          return { data: { id: "task-review-session" } }
        },
        async prompt(options: { body: { parts: { text: string }[] } }) {
          prompt = options.body.parts[0]?.text ?? ""
          return response(validVerdict(input))
        },
      },
    } as never,
    input,
  )

  expect(result.sessionId).toBe("task-review-session")
  expect(result.verdict.decision).toBe("approved")
  expect(prompt).toContain("Build the exact feature.")
  expect(prompt).toContain("Raw deterministic task verification receipt")
  expect(prompt).toContain(input.revision)
  expect(prompt).not.toContain("Task completed.")
})

test("task review rejects wrong bindings, incomplete coverage and invalid approvals", () => {
  const input = taskReviewInput()
  expect(() =>
    parseTaskReview(JSON.stringify({ ...validVerdict(input), task_id: crypto.randomUUID() }), input),
  ).toThrow("wrong task")
  expect(() =>
    parseTaskReview(JSON.stringify({ ...validVerdict(input), revision: "1".repeat(40) }), input),
  ).toThrow("wrong revision")
  expect(() =>
    parseTaskReview(
      JSON.stringify({
        ...validVerdict(input),
        requirements: [],
      }),
      input,
    ),
  ).toThrow("between 1 and 256")
  expect(() =>
    parseTaskReview(
      JSON.stringify({
        ...validVerdict(input),
        requirements: [
          {
            evidence_ids: ["evidence-1"],
            requirement_id: "REQ-1",
            status: "unsatisfied",
          },
        ],
      }),
      input,
    ),
  ).toThrow("cannot approve")
  expect(() =>
    parseTaskReview(
      JSON.stringify({
        ...validVerdict(input),
        requirements: [
          {
            evidence_ids: ["invented"],
            requirement_id: "REQ-1",
            status: "satisfied",
          },
        ],
      }),
      input,
    ),
  ).toThrow("unknown evidence")
  expect(() =>
    parseTaskReview(
      JSON.stringify({
        ...validVerdict(input),
        requirements: [
          ...validVerdict(input).requirements,
          ...validVerdict(input).requirements,
        ],
      }),
      input,
    ),
  ).toThrow("duplicate requirement")
  expect(() =>
    parseTaskReview(
      JSON.stringify({
        ...validVerdict(input),
        requirements: [
          ...validVerdict(input).requirements,
          {
            evidence_ids: ["evidence-1"],
            requirement_id: "REQ-UNASSIGNED",
            status: "satisfied",
          },
        ],
      }),
      input,
    ),
  ).toThrow("unassigned requirement")
  expect(() =>
    parseTaskReview(
      JSON.stringify({
        ...validVerdict(input),
        findings: [{ evidence_ids: ["evidence-1"], severity: "info", summary: "Concern." }],
      }),
      input,
    ),
  ).toThrow("approval cannot contain findings")
  expect(() =>
    parseTaskReview(JSON.stringify({ ...validVerdict(input), unexpected: true }), input),
  ).toThrow("missing or unknown fields")
})

test("task review is unavailable until deterministic verification passes", async () => {
  const input = taskReviewInput({ verificationPassed: false })
  await expect(
    runTaskReview(
      {
        session: {
          async create() {
            throw new Error("reviewer should not start")
          },
        },
      } as never,
      input,
    ),
  ).rejects.toThrow("passed deterministic verification")
})

test("task review requires an exact task, revision, path and command receipt binding", async () => {
  for (const input of [
    taskReviewInput({ verificationTaskId: crypto.randomUUID() }),
    taskReviewInput({ verificationBaseRevision: "1".repeat(40) }),
    taskReviewInput({ verificationRevision: "1".repeat(40) }),
    taskReviewInput({ verificationChangedPaths: [] }),
    taskReviewInput({ verificationInvocation: "bun run lint" }),
  ]) {
    await expect(
      runTaskReview(
        {
          session: {
            async create() {
              throw new Error("reviewer should not start")
            },
          },
        } as never,
        input,
      ),
    ).rejects.toThrow("exact deterministic verification binding")
  }
})

function validVerdict(input: TaskReviewInput) {
  return {
    decision: "approved",
    findings: [],
    repair_target: null,
    requirements: [
      {
        evidence_ids: ["evidence-1"],
        requirement_id: "REQ-1",
        status: "satisfied",
      },
    ],
    revision: input.revision,
    task_id: input.task.id,
  }
}

function taskReviewInput(options: {
  readonly verificationBaseRevision?: string
  readonly verificationChangedPaths?: readonly string[]
  readonly verificationInvocation?: string
  readonly verificationPassed?: boolean
  readonly verificationRevision?: string
  readonly verificationTaskId?: string
} = {}): TaskReviewInput {
  const plan = fixturePlan()
  const task = plan.tasks[0]
  if (task === undefined) throw new Error("Invalid fixture")
  return {
    baseRevision: "0".repeat(40),
    changedPaths: ["feature.txt"],
    directory: process.cwd(),
    model: null,
    originalRequest: "Build the exact feature.",
    parentSessionId: "parent",
    plan,
    revision: "a".repeat(40),
    task,
    verification: {
      baseRevision: options.verificationBaseRevision ?? "0".repeat(40),
      changedPaths: options.verificationChangedPaths ?? ["feature.txt"],
      commands: [
        {
          args: ["test"],
          exitCode: 0,
          id: "evidence-1",
          invocation: options.verificationInvocation ?? "bun test",
          outputDigest: "b".repeat(64),
          outputPreview: "pass",
          status: options.verificationPassed === false ? "failed" : "passed",
          tool: "bun",
        },
      ],
      passed: options.verificationPassed !== false,
      revision: options.verificationRevision ?? "a".repeat(40),
      taskId: options.verificationTaskId ?? task.id,
    },
  }
}

function fixturePlan(): ArchitecturePlanInput {
  return {
    assumptions: [],
    integration_checks: ["Run integration verification."],
    request_digest: "c".repeat(64),
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
        id: crypto.randomUUID(),
        objective: "Implement the bounded task.",
        requirement_ids: ["REQ-1"],
        title: "Implement feature",
        verification_commands: ["bun test"],
        write_scopes: ["feature.txt"],
      },
    ],
  }
}

function response(value: unknown) {
  return { data: { parts: [{ text: JSON.stringify(value), type: "text" }] } }
}
