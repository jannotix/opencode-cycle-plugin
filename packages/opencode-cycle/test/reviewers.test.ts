import { expect, test } from "bun:test"

import type {
  ArchitecturePlanInput,
  CandidateManifestInput,
  VerificationReceipt,
} from "../src/client.js"
import { runIndependentReviews } from "../src/orchestration/reviewers.js"

const evidenceId = "019ff5e2-0439-7030-8a05-0a91b3ed55e2"

test("reviewers run concurrently in isolated sessions without seeing the other verdict", async () => {
  const prompts: { agent: string; text: string }[] = []
  let promptCount = 0
  let release: (() => void) | undefined
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = {
    session: {
      async create(options: { body: { title: string } }) {
        return { data: { id: options.body.title.includes("Functional") ? "functional" : "security" } }
      },
      async prompt(options: {
        body: { agent: string; parts: { text: string }[] }
        path: { id: string }
      }) {
        prompts.push({ agent: options.body.agent, text: options.body.parts[0]?.text ?? "" })
        promptCount += 1
        if (promptCount === 2) release?.()
        await bothStarted
        return {
          data: {
            parts: [
              {
                text: JSON.stringify({
                  decision: "approved",
                  findings: [],
                  repair_target: null,
                  requirements: [
                    {
                      evidence_ids: [evidenceId],
                      requirement_id: "REQ-1",
                      status: "satisfied",
                    },
                  ],
                }),
                type: "text",
              },
            ],
          },
        }
      },
    },
  }
  const sessions: string[] = []
  const reviews = await runIndependentReviews(client as never, {
    candidate,
    candidateDigest: "b".repeat(64),
    directory: "C:/managed-worktree",
    evidence,
    models: {
      functional_reviewer: "provider-a/model-a",
      security_reviewer: "provider-b/model-b",
    },
    onSessionCreated: (session) => sessions.push(session),
    originalRequest: "Deliver the complete feature.",
    parentSessionId: "parent",
    plan,
  })

  expect(sessions.sort()).toEqual(["functional", "security"])
  expect(prompts).toHaveLength(2)
  expect(prompts.every((prompt) => prompt.text.includes("Deliver the complete feature."))).toBeTrue()
  expect(prompts.every((prompt) => prompt.text.includes(evidenceId))).toBeTrue()
  expect(
    prompts.every((prompt) =>
      prompt.text.includes(
        "Independent reviews run before arbitration, delivery, goal linking and goal completion",
      ),
    ),
  ).toBeTrue()
  expect(
    prompts.every((prompt) =>
      prompt.text.includes(
        "base_revision, exact file manifest and candidate-integrity evidence are authoritative",
      ),
    ),
  ).toBeTrue()
  expect(
    prompts.every((prompt) =>
      prompt.text.includes("reject with architecture repair, not execution repair"),
    ),
  ).toBeTrue()
  const securityPrompt = prompts.find((prompt) => prompt.agent.includes("Security"))
  const functionalPrompt = prompts.find((prompt) => prompt.agent.includes("Functional"))
  expect(securityPrompt?.text).toContain("authentication and authorization")
  expect(securityPrompt?.text).toContain("untrusted input")
  expect(securityPrompt?.text).toContain("secret handling")
  expect(securityPrompt?.text).toContain("trust boundaries")
  expect(securityPrompt?.text).toContain("dependency and supply-chain risk")
  expect(functionalPrompt?.text).not.toContain("authentication and authorization")
  expect(reviews.map((review) => review.role).sort()).toEqual([
    "functional_reviewer",
    "security_reviewer",
  ])
  expect(reviews.every((review) => review.verdict.candidate_digest === "b".repeat(64))).toBeTrue()
})

test("reviewer output fails closed on unknown fields and empty evidence", async () => {
  const client = {
    session: {
      async create() {
        return { data: { id: crypto.randomUUID() } }
      },
      async prompt() {
        return {
          data: {
            parts: [
              {
                text: JSON.stringify({
                  decision: "approved",
                  findings: [],
                  repair_target: null,
                  requirements: [
                    { evidence_ids: [], requirement_id: "REQ-1", status: "satisfied" },
                  ],
                }),
                type: "text",
              },
            ],
          },
        }
      },
    },
  }
  await expect(
    runIndependentReviews(client as never, {
      candidate,
      candidateDigest: "b".repeat(64),
      directory: "C:/managed-worktree",
      evidence,
      models: {},
      originalRequest: "Request",
      parentSessionId: "parent",
      plan,
    }),
  ).rejects.toThrow("non-empty bounded")
})

test("a reviewer retries an empty provider result in a new isolated session", async () => {
  const attempts = new Map<string, number>()
  const sessions: string[] = []
  const client = {
    session: {
      async create(options: { body: { title: string } }) {
        const role = options.body.title.includes("Functional") ? "functional" : "security"
        const attempt = (attempts.get(role) ?? 0) + 1
        attempts.set(role, attempt)
        return { data: { id: `${role}-${attempt}` } }
      },
      async prompt(options: { path: { id: string } }) {
        if (options.path.id === "security-1") return { data: undefined }
        return {
          data: {
            parts: [
              {
                text: JSON.stringify({
                  decision: "approved",
                  findings: [],
                  repair_target: null,
                  requirements: [
                    {
                      evidence_ids: [evidenceId],
                      requirement_id: "REQ-1",
                      status: "satisfied",
                    },
                  ],
                }),
                type: "text",
              },
            ],
          },
        }
      },
    },
  }

  const reviews = await runIndependentReviews(client as never, {
    candidate,
    candidateDigest: "b".repeat(64),
    directory: "C:/managed-worktree",
    evidence,
    models: {},
    onSessionCreated: (session) => sessions.push(session),
    originalRequest: "Request",
    parentSessionId: "parent",
    plan,
  })

  expect(attempts).toEqual(new Map([["functional", 1], ["security", 2]]))
  expect(sessions.sort()).toEqual(["functional-1", "security-1", "security-2"])
  expect(reviews).toHaveLength(2)
})

test("reviewers forward cancellation and do not retry an aborted run", async () => {
  const calls: { readonly signal?: AbortSignal }[] = []
  const controller = new AbortController()
  const client = {
    session: {
      async create(input: { signal?: AbortSignal }) {
        calls.push(input)
        return { data: { id: `reviewer-${calls.length}` } }
      },
      async prompt(input: { signal?: AbortSignal }) {
        calls.push(input)
        return {
          data: {
            parts: [
              {
                text: JSON.stringify({
                  decision: "approved",
                  findings: [],
                  repair_target: null,
                  requirements: [
                    {
                      evidence_ids: [evidenceId],
                      requirement_id: "REQ-1",
                      status: "satisfied",
                    },
                  ],
                }),
                type: "text",
              },
            ],
          },
        }
      },
    },
  }

  await runIndependentReviews(client as never, {
    candidate,
    candidateDigest: "b".repeat(64),
    directory: "C:/managed-worktree",
    evidence,
    models: {},
    originalRequest: "Request",
    parentSessionId: "parent",
    plan,
    signal: controller.signal,
  })
  expect(calls).toHaveLength(4)
  expect(calls.every((call) => call.signal === controller.signal)).toBeTrue()

  const aborted = new AbortController()
  aborted.abort(new Error("stopped"))
  calls.length = 0
  await expect(
    runIndependentReviews(client as never, {
      candidate,
      candidateDigest: "b".repeat(64),
      directory: "C:/managed-worktree",
      evidence,
      models: {},
      originalRequest: "Request",
      parentSessionId: "parent",
      plan,
      signal: aborted.signal,
    }),
  ).rejects.toThrow("stopped")
  expect(calls).toHaveLength(0)
})

const plan: ArchitecturePlanInput = {
  assumptions: [],
  integration_checks: ["Run integration verification."],
  request_digest: "a".repeat(64),
  requirements: [
    {
      acceptance_criteria: ["Feature works."],
      id: "REQ-1",
      statement: "Implement the complete feature.",
    },
  ],
  risks: [],
  tasks: [
    {
      acceptance_criteria: ["Task works."],
      dependencies: [],
      id: crypto.randomUUID(),
      objective: "Implement the task.",
      requirement_ids: ["REQ-1"],
      title: "Implement",
      verification_commands: ["project-test"],
      write_scopes: ["src"],
    },
  ],
}

const candidate: CandidateManifestInput = {
  base_revision: "c".repeat(40),
  candidate_id: crypto.randomUUID(),
  configuration_digest: "d".repeat(64),
  dependency_state_digest: "e".repeat(64),
  diff_digest: "f".repeat(64),
  environment_digest: "0".repeat(64),
  evidence_ids: [evidenceId],
  files: [],
}

const evidence: VerificationReceipt["evidence"] = [
  {
    output: "passed",
    record: {
      candidate_digest: "b".repeat(64),
      exit_code: 0,
      finished_at: "2026-08-12T10:00:01Z",
      id: evidenceId,
      invocation: "project-test",
      kind: "test",
      output_digest: "1".repeat(64),
      skip_reason: null,
      started_at: "2026-08-12T10:00:00Z",
      status: "passed",
      tool: "project-test",
      tool_version: "1",
    },
  },
]
