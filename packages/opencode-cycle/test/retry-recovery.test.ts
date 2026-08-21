import { expect, test } from "bun:test"
import { resolve } from "node:path"

import { recoverWorkflowRetry } from "../src/orchestration/retry-recovery.js"

const workflowId = "018f47d0-a9b2-7c1d-8a77-123456789abc"
const candidateId = "018f47d0-a9b2-7c1d-8a77-123456789abd"
const planId = "018f47d0-a9b2-7c1d-8a77-123456789abe"
const evidenceId = "018f47d0-a9b2-7c1d-8a77-123456789abf"
const candidateDigest = "a".repeat(64)

function context(state: "arbitration" | "delivery" | "independent_reviews" | "verification") {
  return {
    candidateDigest,
    candidateId,
    evidence: [
      {
        output: "passed",
        record: {
          candidate_digest: candidateDigest,
          exit_code: 0,
          finished_at: "2026-08-15T10:00:01Z",
          id: evidenceId,
          invocation: "bun test",
          kind: "test",
          output_digest: "b".repeat(64),
          skip_reason: null,
          started_at: "2026-08-15T10:00:00Z",
          status: "passed",
          tool: "bun",
          tool_version: "1",
        },
      },
    ],
    executorSessionIds: ["executor-session"],
    manifest: {
      base_revision: "base",
      candidate_id: candidateId,
      configuration_digest: "c".repeat(64),
      dependency_state_digest: "d".repeat(64),
      diff_digest: "e".repeat(64),
      environment_digest: "f".repeat(64),
      evidence_ids: [evidenceId],
      files: [{ digest: "1".repeat(64), kind: "modified", path: "src/app.ts" }],
    },
    mode: "quick",
    originalRequest: "Implement the exact requested change.",
    plan: {
      assumptions: [],
      integration_checks: ["Run tests."],
      request_digest: "2".repeat(64),
      requirements: [
        {
          acceptance_criteria: ["The change works."],
          id: "REQ-1",
          statement: "Implement the requested change.",
        },
      ],
      risks: [],
      tasks: [],
    },
    reviews: [],
    state,
    verificationPlanId: planId,
    workflowId,
    worktreePath: resolve("state", "worktrees", "project", "cycle"),
  }
}

function earlyContext(state: "architecture" | "execution" | "quick_execution") {
  const value = {
    baseRevision: "1".repeat(40),
    mode: state === "quick_execution" ? ("quick" as const) : ("full" as const),
    originalRequest: "Implement the exact requested change.",
    repairFeedback: "The previous candidate did not satisfy REQ-1.",
    requestDigest: "2".repeat(64),
    state,
    workflowId,
    worktreePath: resolve("state", "worktrees", "project", "cycle"),
  }
  return state === "architecture" ? value : { ...value, plan: context("arbitration").plan }
}

function approval() {
  return {
    decision: "approved",
    findings: [],
    repair_target: null,
    requirements: [
      { evidence_ids: [evidenceId], requirement_id: "REQ-1", status: "satisfied" },
    ],
  }
}

function client(calls: unknown[]) {
  return {
    session: {
      async create(input: unknown) {
        calls.push({ create: input })
        return { data: { id: "arbiter-session" } }
      },
      async prompt(input: { body: { agent: string; model?: unknown } }) {
        calls.push({ prompt: input })
        return { data: { parts: [{ text: JSON.stringify(approval()), type: "text" }] } }
      },
    },
  }
}

test("orphaned arbitration invokes the configured arbiter with the original request and delivers", async () => {
  const calls: unknown[] = []
  const controller = new AbortController()
  const plane = {
    async audit(value: unknown) {
      calls.push({ audit: value })
      return { entryHash: "3".repeat(64), sequence: 1 }
    },
    async control(_projectKey: string, operation: string) {
      calls.push({ control: operation })
      return operation === "recovery" ? context("arbitration") : { state: "arbitration", workflowId }
    },
    async promoteCandidate(...args: unknown[]) {
      calls.push({ promote: args })
      return { changedPaths: ["src/app.ts"], workflowState: "completed" }
    },
    async submitArbitration(_project: string, _workflow: string, _candidate: string, verdict: unknown) {
      calls.push({ arbitration: verdict })
      return {
        decision: "approved",
        receipt: {},
        receiptDigest: "4".repeat(64),
        workflowState: "delivery",
      }
    },
  }
  const sessions: unknown[] = []
  const result = await recoverWorkflowRetry(client(calls) as never, plane as never, {
    active: false,
    activeModel: "fallback/model",
    browserAttestations: async () => [],
    models: { arbiter: "openai/gpt-5.6-sol" },
    parentSessionId: "parent",
    projectDirectory: "C:/project",
    projectKey: "project",
    registerSession: (sessionId, role) => sessions.push({ role, sessionId }),
    result: { duplicate: false, state: "arbitration", workflowId },
    signal: controller.signal,
  })

  expect(result).toEqual({
    duplicate: false,
    recovery: { changedPaths: ["src/app.ts"], workflowState: "completed" },
    state: "completed",
    workflowId,
  })
  expect(sessions).toEqual([{ role: "arbiter", sessionId: "arbiter-session" }])
  const prompt = calls.find((entry) => "prompt" in (entry as Record<string, unknown>)) as {
    prompt: { body: { model: unknown; parts: { text: string }[] }; signal?: AbortSignal }
  }
  expect(prompt.prompt.body.model).toEqual({ modelID: "gpt-5.6-sol", providerID: "openai" })
  expect(prompt.prompt.signal).toBe(controller.signal)
  expect(prompt.prompt.body.parts[0]?.text).toContain("Implement the exact requested change.")
  expect(calls.some((entry) => "arbitration" in (entry as Record<string, unknown>))).toBeTrue()
  expect(calls.some((entry) => "promote" in (entry as Record<string, unknown>))).toBeTrue()
})

test("orphaned verification reuses persisted executor browser evidence before arbitration", async () => {
  const calls: unknown[] = []
  let recoveryState: "verification" | "arbitration" = "verification"
  const plane = {
    async audit() {
      return { entryHash: "3".repeat(64), sequence: 1 }
    },
    async control(_projectKey: string, operation: string) {
      if (operation === "recovery") return context(recoveryState)
      return { state: recoveryState, workflowId }
    },
    async verifyCandidate(...args: unknown[]) {
      calls.push({ verify: args })
      recoveryState = "arbitration"
      return { evidence: context("arbitration").evidence, mandatoryPassed: true, workflowState: "arbitration" }
    },
    async submitArbitration() {
      return { decision: "rejected", receipt: {}, receiptDigest: "4".repeat(64), workflowState: "execution" }
    },
  }
  const attestations = [{
    candidate_digest: candidateDigest,
    receipt_digest: "5".repeat(64),
    receipt_json: "{}",
    session_id: "executor-session",
  }]
  const result = await recoverWorkflowRetry(client(calls) as never, plane as never, {
    active: false,
    activeModel: null,
    async browserAttestations(sessionIds, digest) {
      calls.push({ attest: { digest, sessionIds } })
      return attestations
    },
    models: { arbiter: "openai/gpt-5.6-sol" },
    parentSessionId: "parent",
    projectDirectory: "C:/project",
    projectKey: "project",
    registerSession() {},
    result: { duplicate: false, state: "verification", workflowId },
  })

  expect(calls).toContainEqual({ attest: { digest: candidateDigest, sessionIds: ["executor-session"] } })
  expect(calls).toContainEqual({
    verify: ["project", workflowId, candidateId, planId, attestations],
  })
  expect(result).toEqual({ duplicate: false, state: "execution", workflowId })
})

test("orphaned full workflow restores both independent reviewers before arbitration", async () => {
  const calls: { agent: string; model?: unknown }[] = []
  const fullContext = { ...context("independent_reviews"), mode: "full" as const }
  const recoveryClient = {
    session: {
      async create(input: { body: { title: string } }) {
        return { data: { id: `${input.body.title}-session` } }
      },
      async prompt(input: { body: { agent: string; model?: unknown } }) {
        calls.push({ agent: input.body.agent, ...(input.body.model === undefined ? {} : { model: input.body.model }) })
        return { data: { parts: [{ text: JSON.stringify(approval()), type: "text" }] } }
      },
    },
  }
  let reviews = 0
  const plane = {
    async audit() {
      return { entryHash: "3".repeat(64), sequence: 1 }
    },
    async control(_projectKey: string, operation: string) {
      return operation === "recovery" ? fullContext : { state: "independent_reviews", workflowId }
    },
    async submitReview() {
      reviews += 1
      return { reviewsReady: reviews === 2 }
    },
    async submitArbitration() {
      return { decision: "rejected", receipt: {}, receiptDigest: "4".repeat(64), workflowState: "execution" }
    },
  }

  await recoverWorkflowRetry(recoveryClient as never, plane as never, {
    active: false,
    activeModel: null,
    browserAttestations: async () => [],
    models: {
      arbiter: "openai/gpt-5.6-sol",
      functional_reviewer: "minimax-coding-plan/MiniMax-M3",
      security_reviewer: "opencode-go/deepseek-v4-pro",
    },
    parentSessionId: "parent",
    projectDirectory: "C:/project",
    projectKey: "project",
    registerSession() {},
    result: { duplicate: false, state: "independent_reviews", workflowId },
  })

  expect(reviews).toBe(2)
  expect(calls).toEqual([
    {
      agent: "Cycle Functional Reviewer",
      model: { modelID: "MiniMax-M3", providerID: "minimax-coding-plan" },
    },
    {
      agent: "Cycle Security and Architecture Reviewer",
      model: { modelID: "deepseek-v4-pro", providerID: "opencode-go" },
    },
    { agent: "Cycle Arbiter", model: { modelID: "gpt-5.6-sol", providerID: "openai" } },
  ])
})

test.each(["architecture", "execution", "quick_execution"] as const)(
  "orphaned %s repair resumes the governed pipeline from durable context",
  async (state) => {
    const calls: unknown[] = []
    const plane = {
      async control(_projectKey: string, operation: string) {
        calls.push({ control: operation })
        return operation === "recovery" ? earlyContext(state) : { state, workflowId }
      },
    }
    let resumed: unknown

    const result = await recoverWorkflowRetry(client(calls) as never, plane as never, {
      active: false,
      activeModel: null,
      browserAttestations: async () => [],
      models: {},
      parentSessionId: "parent",
      projectDirectory: "C:/project",
      projectKey: "project",
      registerSession() {},
      result: { duplicate: false, state, workflowId },
      async resumeEarlyStage(context) {
        resumed = context
        return { state: "completed" }
      },
    })

    expect(resumed).toEqual(earlyContext(state))
    expect(result).toEqual({ duplicate: false, state: "completed", workflowId })
    expect(calls).toContainEqual({ control: "recovery" })
  },
)

test("orphaned quick_execution without architecture resumes the governed pipeline", async () => {
  const { plan: _plan, ...recovery } = earlyContext("quick_execution")
  const plane = {
    async control(_projectKey: string, operation: string) {
      return operation === "recovery" ? recovery : { state: "quick_execution", workflowId }
    },
  }
  let resumed: unknown

  const result = await recoverWorkflowRetry(client([]) as never, plane as never, {
    active: false,
    activeModel: null,
    browserAttestations: async () => [],
    models: {},
    parentSessionId: "parent",
    projectDirectory: "C:/project",
    projectKey: "project",
    registerSession() {},
    result: { duplicate: false, state: "quick_execution", workflowId },
    async resumeEarlyStage(context) {
      resumed = context
      return { state: "completed" }
    },
  })

  expect(resumed).toEqual(recovery)
  expect(result).toEqual({ duplicate: false, state: "completed", workflowId })
})

test("orphaned quick verification repair resumes execution with persisted evidence", async () => {
  const recovery = {
    ...earlyContext("execution"),
    mode: "quick" as const,
    repairFeedback: JSON.stringify([{ mandatory: true, output: "failed" }]),
  }
  const plane = {
    async control(_projectKey: string, operation: string) {
      return operation === "recovery" ? recovery : { state: "execution", workflowId }
    },
  }
  let resumed: unknown

  await recoverWorkflowRetry(client([]) as never, plane as never, {
    active: false,
    activeModel: null,
    browserAttestations: async () => [],
    models: {},
    parentSessionId: "parent",
    projectDirectory: "C:/project",
    projectKey: "project",
    registerSession() {},
    result: { duplicate: false, state: "execution", workflowId },
    async resumeEarlyStage(context) {
      resumed = context
      return { state: "completed" }
    },
  })

  expect(resumed).toEqual(recovery)
})

test("active workflow retry remains owned by its background orchestrator", async () => {
  const calls: unknown[] = []
  const result = { duplicate: false, state: "delivery", workflowId }

  expect(
    await recoverWorkflowRetry(client(calls) as never, {} as never, {
      active: true,
      activeModel: null,
      browserAttestations: async () => [],
      models: {},
      parentSessionId: "parent",
      projectDirectory: "C:/project",
      projectKey: "project",
      registerSession() {},
      result,
    }),
  ).toBe(result)
  expect(calls).toEqual([])
})

test("malformed retry responses fail closed without recovery", async () => {
  expect(
    recoverWorkflowRetry(client([]) as never, {} as never, {
      active: false,
      activeModel: null,
      browserAttestations: async () => [],
      models: {},
      parentSessionId: "parent",
      projectDirectory: "C:/project",
      projectKey: "project",
      registerSession() {},
      result: { state: "delivery" },
    }),
  ).rejects.toThrow("workflow identifier")
})

test("cancellation after an arbiter response prevents state mutation and delivery", async () => {
  const controller = new AbortController()
  let arbitrationCalls = 0
  let deliveryCalls = 0
  const plane = {
    async audit() {
      return { entryHash: "3".repeat(64), sequence: 1 }
    },
    async control(_projectKey: string, operation: string) {
      return operation === "recovery" ? context("arbitration") : { state: "arbitration", workflowId }
    },
    async promoteCandidate() {
      deliveryCalls += 1
      return { changedPaths: [], workflowState: "completed" }
    },
    async submitArbitration() {
      arbitrationCalls += 1
      return {
        decision: "approved",
        receipt: {},
        receiptDigest: "4".repeat(64),
        workflowState: "delivery",
      }
    },
  }
  const abortingClient = {
    session: {
      async create() {
        return { data: { id: "arbiter-session" } }
      },
      async prompt() {
        controller.abort(new Error("stopped"))
        return { data: { parts: [{ text: JSON.stringify(approval()), type: "text" }] } }
      },
    },
  }

  await expect(
    recoverWorkflowRetry(abortingClient as never, plane as never, {
      active: false,
      activeModel: null,
      browserAttestations: async () => [],
      models: {},
      parentSessionId: "parent",
      projectDirectory: "C:/project",
      projectKey: "project",
      registerSession() {},
      result: { state: "arbitration", workflowId },
      signal: controller.signal,
    }),
  ).rejects.toThrow("stopped")
  expect(arbitrationCalls).toBe(0)
  expect(deliveryCalls).toBe(0)
})
