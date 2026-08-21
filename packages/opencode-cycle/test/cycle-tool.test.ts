import { expect, test } from "bun:test"

import type { WorkflowControlPlane } from "../src/control-plane.js"
import { cycleControlTool } from "../src/cycle-tool.js"

function controlPlane(calls: unknown[]): WorkflowControlPlane {
  return {
    async audit() {
      return { entryHash: "0".repeat(64), sequence: 0 }
    },
    async control(projectKey, operation) {
      calls.push({ operation, projectKey })
      return { status: "ok" }
    },
    async dispose() {},
    async health() {
      return {
        product_version: "1.0.0",
        protocol_version: 1,
        schema_mode: "read_write",
        schema_version: 17,
      }
    },
    async goal(projectKey, operation) {
      calls.push({ operation, projectKey })
      return { status: "ok" }
    },
    async history(projectKey, operation) {
      calls.push({ operation, projectKey })
      return { status: "ok" }
    },
    async memory(projectKey, operation) {
      calls.push({ operation, projectKey })
      return { status: "ok" }
    },
    async startWorkflow() {
      return { mode: "full", requestDigest: "0".repeat(64), workflowId: crypto.randomUUID() }
    },
    async submitArchitecture() {},
  }
}

const context = {
  abort: new AbortController().signal,
  agent: "Cycle",
  ask: async () => {},
  directory: "C:/project",
  messageID: "message",
  metadata() {},
  sessionID: "session",
  worktree: "C:/project",
}

test("cycle control tool maps native history operations", async () => {
  const calls: unknown[] = []
  const definition = cycleControlTool(controlPlane(calls), "project")
  const result = await definition.execute(
    { afterSequence: 9, limit: 25, operation: "history" },
    context,
  )
  expect(calls).toEqual([
    {
      operation: { after_sequence: 9, limit: 25, type: "query" },
      projectKey: "project",
    },
  ])
  expect(result).toEqual({
    output: '{\n  "status": "ok"\n}',
    title: "Cycle for OpenCode history",
  })
})

test("workflow export fails closed without explicit confirmation", async () => {
  const definition = cycleControlTool(controlPlane([]), "project")
  expect(definition.execute({ operation: "export" }, context)).rejects.toThrow(
    "requires confirmed=true",
  )
})

test("memory operations are typed and destructive access fails closed", async () => {
  const calls: unknown[] = []
  const definition = cycleControlTool(controlPlane(calls), "project")
  await definition.execute(
    { confidence: "verified", operation: "memory_search", scope: "backend", text: "routing" },
    context,
  )
  expect(calls).toEqual([
    {
      operation: {
        confidence: "verified",
        limit: 100,
        scope: "backend",
        text: "routing",
        type: "search",
      },
      projectKey: "project",
    },
  ])
  expect(
    definition.execute(
      { memoryId: "018f47d0-a9b2-7c1d-8a77-123456789abc", operation: "memory_remove" },
      context,
    ),
  ).rejects.toThrow("requires confirmed=true")
})

test("setup runs native host inspection only when requested", async () => {
  const sessions: string[] = []
  const definition = cycleControlTool(controlPlane([]), "project", {
    async inspect(sessionId) {
      sessions.push(sessionId)
      return { permissionPreset: "balanced" }
    },
  })

  const result = await definition.execute({ operation: "setup" }, context)

  expect(sessions).toEqual(["session"])
  expect(result).toEqual({
    output: '{\n  "permissionPreset": "balanced"\n}',
    title: "Cycle for OpenCode setup",
  })
})

test("status and lifecycle commands use native control and cancellation fails closed", async () => {
  const calls: unknown[] = []
  const definition = cycleControlTool(controlPlane(calls), "project")

  await definition.execute({ operation: "status" }, context)
  await definition.execute({ operation: "pause" }, context)

  expect(calls).toEqual([
    { operation: "status", projectKey: "project" },
    { operation: "pause", projectKey: "project" },
  ])
  expect(definition.execute({ operation: "cancel" }, context)).rejects.toThrow("confirmed=true")
})

test("retry resumes an orphaned delivery through the native orchestrator", async () => {
  const calls: unknown[] = []
  const plane = controlPlane(calls)
  plane.control = async (projectKey, operation, workflowId) => {
    calls.push({ operation, projectKey, workflowId })
    return {
      state: "delivery",
      workflowId: "018f47d0-a9b2-7c1d-8a77-123456789abc",
    }
  }
  const recoveries: unknown[] = []
  const definition = cycleControlTool(plane, "project", {
    async inspect() {
      return {}
    },
    async recoverRetry(sessionId, result, signal) {
      recoveries.push({ result, sessionId, signal })
      return { state: "completed", workflowId: "018f47d0-a9b2-7c1d-8a77-123456789abc" }
    },
  })

  const result = await definition.execute(
    {
      operation: "retry",
      workflowId: "018f47d0-a9b2-7c1d-8a77-123456789abc",
    },
    context,
  )

  expect(calls).toEqual([
    {
      operation: "retry",
      projectKey: "project",
      workflowId: "018f47d0-a9b2-7c1d-8a77-123456789abc",
    },
  ])
  expect(recoveries).toEqual([
    {
      result: {
        state: "delivery",
        workflowId: "018f47d0-a9b2-7c1d-8a77-123456789abc",
      },
      sessionId: "session",
      signal: context.abort,
    },
  ])
  expect(result.output).toContain('"state": "completed"')
})

test("run, models, permissions and limits use native host configuration", async () => {
  const routed: string[] = []
  const definition = cycleControlTool(controlPlane([]), "project", {
    async inspect() {
      return {}
    },
    inspectLimits() {
      return { maximumRepairCycles: 5 }
    },
    inspectModels(_sessionId, role, model) {
      return { model, role }
    },
    inspectPermissions() {
      return { preset: "balanced" }
    },
    setRoutingPreference(_sessionId, mode) {
      routed.push(mode)
      return { mode }
    },
  })

  await definition.execute({ mode: "full", operation: "run" }, context)
  const models = await definition.execute(
    { model: "provider/model", operation: "models", role: "arbiter" },
    context,
  )
  const permissions = await definition.execute({ operation: "permissions" }, context)
  const limits = await definition.execute({ operation: "limits" }, context)

  expect(routed).toEqual(["full"])
  expect(models.output).toContain("provider/model")
  expect(permissions.output).toContain("balanced")
  expect(limits.output).toContain("5")
})

test("doctor includes host compatibility in the user-visible result", async () => {
  const definition = cycleControlTool(controlPlane([]), "project", {
    async inspect() {
      return {}
    },
    inspectGit() {
      return { message: "Project directory is a Git repository.", repository: true }
    },
    inspectHost() {
      return {
        certified: false,
        certifiedVersions: ["1.18.16", "1.18.18"],
        compatible: true,
        message: "OpenCode 1.18.19 matches the 1.x plugin contract.",
        minimumVersion: "1.18.16",
        version: "1.18.19",
      }
    },
  })
  const result = await definition.execute({ operation: "doctor" }, context)
  expect(result.output).toContain("1.18.19")
  expect(result.output).toContain('"compatible": true')
  expect(result.output).toContain('"repository": true')
  expect(result.title).toBe("Cycle for OpenCode doctor")
})

test("run starts the exact pending request instead of trusting model-generated text", async () => {
  const started: unknown[] = []
  const definition = cycleControlTool(controlPlane([]), "project", {
    async inspect() {
      return {}
    },
    run(sessionId, mode, _goalId, _milestone, signal) {
      started.push({ mode, sessionId, signal })
      return { mode, requestDigest: "a".repeat(64), workflowId: crypto.randomUUID() }
    },
  })

  const result = await definition.execute({ mode: "full", operation: "run" }, context)

  expect(started).toEqual([{ mode: "full", sessionId: "session", signal: context.abort }])
  expect(result.title).toBe("Cycle for OpenCode started")
})

test("goal creation uses the exact pending user request and native approval", async () => {
  const calls: unknown[] = []
  const approvals: unknown[] = []
  const definition = cycleControlTool(controlPlane(calls), "project", {
    async inspect() {
      return {}
    },
    pendingRequest() {
      return "Build the SaaS exactly as requested"
    },
  })

  const result = await definition.execute(
    {
      constraints: ["Use stable dependencies"],
      nonGoals: ["Mobile app"],
      operation: "goal_create",
      successCriteria: ["Paid signup works end to end"],
    },
    {
      ...context,
      ask: async (request: unknown) => {
        approvals.push(request)
      },
    },
  )

  expect(approvals).toHaveLength(1)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    operation: {
      constraints: ["Use stable dependencies"],
      max_continuations: 5,
      non_goals: ["Mobile app"],
      objective: "Build the SaaS exactly as requested",
      session_id: "session",
      success_criteria: ["Paid signup works end to end"],
      type: "create",
    },
    projectKey: "project",
  })
  expect(result.title).toBe("Cycle for OpenCode goal create")
})

test("goal planning and lifecycle operations map to persisted goal state", async () => {
  const calls: unknown[] = []
  const definition = cycleControlTool(controlPlane(calls), "project", {
    async inspect() {
      return {}
    },
    pendingRequest() {
      return "Add billing as a new goal amendment"
    },
  })
  const goalId = "018f47d0-a9b2-7c1d-8a77-123456789abc"

  await definition.execute({ goalId, operation: "goal_status" }, context)
  await definition.execute({ goalId, operation: "goal_amend" }, context)
  await definition.execute({ document: "# Plan\n\nMilestone 1", goalId, operation: "goal_save_plan" }, context)
  await definition.execute(
    { goalId, operation: "goal_transition", transition: "mark_ready" },
    context,
  )

  expect(calls).toHaveLength(4)
  expect(calls[0]).toEqual({
    operation: { goal_id: goalId, session_id: "session", type: "status" },
    projectKey: "project",
  })
  expect(calls[1]).toMatchObject({
    operation: { goal_id: goalId, text: "Add billing as a new goal amendment", type: "amend" },
    projectKey: "project",
  })
  expect(calls[2]).toEqual({
    operation: {
      content: "# Plan\n\nMilestone 1",
      goal_id: goalId,
      source_session_id: "session",
      type: "save_plan",
    },
    projectKey: "project",
  })
  expect(calls[3]).toMatchObject({
    operation: { action: "mark_ready", goal_id: goalId, type: "control" },
    projectKey: "project",
  })
})

test("goal completion evidence rejects non-digest text before IPC", async () => {
  const calls: unknown[] = []
  const definition = cycleControlTool(controlPlane(calls), "project")

  await expect(
    definition.execute(
      {
        completionEvidence: "The arbiter approved the workflow",
        goalId: "018f47d0-a9b2-7c1d-8a77-123456789abc",
        operation: "goal_transition",
        transition: "approve_completion",
      },
      context,
    ),
  ).rejects.toThrow("SHA-256 digest")
  expect(calls).toHaveLength(0)
})
