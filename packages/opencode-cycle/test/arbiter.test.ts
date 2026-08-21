import { expect, test } from "bun:test"

import { runArbiter } from "../src/orchestration/arbiter.js"

const evidenceId = "019ff5e2-0439-7030-8a05-0a91b3ed55e2"
const output = {
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
}

test("arbiter receives the immutable original request and both finalized reviews directly", async () => {
  const calls: unknown[] = []
  const result = await runArbiter(
    {
      session: {
        async create(options: unknown) {
          calls.push({ create: options })
          return { data: { id: "arbiter-session" } }
        },
        async prompt(options: unknown) {
          calls.push({ prompt: options })
          return { data: { parts: [{ text: JSON.stringify(output), type: "text" }] } }
        },
      },
    } as never,
    {
      candidate: {
        base_revision: "a".repeat(40),
        candidate_id: crypto.randomUUID(),
        configuration_digest: "b".repeat(64),
        dependency_state_digest: "c".repeat(64),
        diff_digest: "d".repeat(64),
        environment_digest: "e".repeat(64),
        evidence_ids: [evidenceId],
        files: [],
      },
      candidateDigest: "f".repeat(64),
      directory: "C:/managed-worktree",
      evidence: [
        {
          output: "passed",
          record: {
            candidate_digest: "f".repeat(64),
            exit_code: 0,
            finished_at: "2026-08-12T10:00:01Z",
            id: evidenceId,
            invocation: "project-test",
            kind: "test",
            output_digest: "0".repeat(64),
            skip_reason: null,
            started_at: "2026-08-12T10:00:00Z",
            status: "passed",
            tool: "project-test",
            tool_version: "1",
          },
        },
      ],
      model: "provider/model",
      mode: "full",
      originalRequest: "ORIGINAL REQUEST MUST BE AUTHORITATIVE",
      parentSessionId: "parent",
      plan: {
        assumptions: [],
        integration_checks: ["Run the flow."],
        request_digest: "1".repeat(64),
        requirements: [
          { acceptance_criteria: ["Works."], id: "REQ-1", statement: "Build it." },
        ],
        risks: [],
        tasks: [
          {
            acceptance_criteria: ["Works."],
            dependencies: [],
            id: crypto.randomUUID(),
            objective: "Build it.",
            requirement_ids: ["REQ-1"],
            title: "Build",
            verification_commands: ["project-test"],
            write_scopes: ["src"],
          },
        ],
      },
      reviews: [
        {
          candidate_digest: "f".repeat(64),
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
          role: "functional_reviewer",
        },
        {
          candidate_digest: "f".repeat(64),
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
          role: "security_architecture_reviewer",
        },
      ],
    },
  )

  expect(result.verdict.candidate_digest).toBe("f".repeat(64))
  expect(result.sessionId).toBe("arbiter-session")
  expect(JSON.stringify(calls[1])).toContain("ORIGINAL REQUEST MUST BE AUTHORITATIVE")
  expect(JSON.stringify(calls[1])).toContain("functional_reviewer")
  expect(JSON.stringify(calls[1])).toContain("security_architecture_reviewer")
  expect(JSON.stringify(calls[1])).toContain(
    "Delivery, goal linking and goal completion occur only after this verdict",
  )
  expect(JSON.stringify(calls[1])).toContain(
    "base_revision, exact file manifest and candidate-integrity evidence are authoritative",
  )
})

test("arbiter rejects prose and missing evidence identifiers", async () => {
  const client = (text: string) =>
    ({
      session: {
        async create() {
          return { data: { id: "arbiter" } }
        },
        async prompt() {
          return { data: { parts: [{ text, type: "text" }] } }
        },
      },
    }) as never
  const input = {
    candidate: { evidence_ids: [evidenceId] } as never,
    candidateDigest: "f".repeat(64),
    directory: "C:/managed-worktree",
    evidence: [],
    model: null,
    mode: "full" as const,
    originalRequest: "Request",
    parentSessionId: "parent",
    plan: {
      requirements: [
        { acceptance_criteria: ["Works."], id: "REQ-1", statement: "Build it." },
      ],
    } as never,
    reviews: [{}, {}] as never,
  }
  await expect(runArbiter(client("approved"), input)).rejects.toThrow("valid JSON")
  await expect(
    runArbiter(
      client(
        JSON.stringify({
          ...output,
          requirements: [{ ...output.requirements[0], evidence_ids: [] }],
        }),
      ),
      input,
    ),
  ).rejects.toThrow("non-empty bounded")
})

test("arbiter retries a verdict that invents a requirement identifier", async () => {
  let attempts = 0
  const prompts: string[] = []
  const client = {
    session: {
      async create() {
        return { data: { id: `arbiter-${attempts + 1}` } }
      },
      async prompt(options: { body: { parts: { text: string }[] } }) {
        attempts += 1
        prompts.push(options.body.parts[0]?.text ?? "")
        const verdict =
          attempts === 1
            ? {
                ...output,
                requirements: [
                  {
                    ...output.requirements[0],
                    requirement_id: "REQ-6",
                  },
                ],
              }
            : output
        return { data: { parts: [{ text: JSON.stringify(verdict), type: "text" }] } }
      },
    },
  } as never

  const result = await runArbiter(client, {
    candidate: { evidence_ids: [evidenceId] } as never,
    candidateDigest: "f".repeat(64),
    directory: "C:/managed-worktree",
    evidence: [] as never,
    model: null,
    mode: "full",
    originalRequest: "Request",
    parentSessionId: "parent",
    plan: {
      requirements: [
        { acceptance_criteria: ["Works."], id: "REQ-1", statement: "Build it." },
      ],
    } as never,
    reviews: [{}, {}] as never,
  })

  expect(attempts).toBe(2)
  expect(result.verdict.requirements[0]?.requirement_id).toBe("REQ-1")
  expect(prompts[1]).toContain("REQ-6")
})

test("arbiter forwards cancellation and does not retry an aborted run", async () => {
  const calls: { readonly signal?: AbortSignal }[] = []
  const controller = new AbortController()
  const client = {
    session: {
      async create(input: { signal?: AbortSignal }) {
        calls.push(input)
        return { data: { id: "arbiter-session" } }
      },
      async prompt(input: { signal?: AbortSignal }) {
        calls.push(input)
        return { data: { parts: [{ text: JSON.stringify(output), type: "text" }] } }
      },
    },
  } as never
  const input = {
    candidate: { evidence_ids: [evidenceId] } as never,
    candidateDigest: "f".repeat(64),
    directory: "C:/managed-worktree",
    evidence: [] as never,
    model: null,
    mode: "full" as const,
    originalRequest: "Request",
    parentSessionId: "parent",
    plan: {
      requirements: [
        { acceptance_criteria: ["Works."], id: "REQ-1", statement: "Build it." },
      ],
    } as never,
    reviews: [{}, {}] as never,
    signal: controller.signal,
  }

  await runArbiter(client, input)
  expect(calls).toHaveLength(2)
  expect(calls.every((call) => call.signal === controller.signal)).toBeTrue()

  const aborted = new AbortController()
  aborted.abort(new Error("stopped"))
  calls.length = 0
  await expect(runArbiter(client, { ...input, signal: aborted.signal })).rejects.toThrow("stopped")
  expect(calls).toHaveLength(0)
})
