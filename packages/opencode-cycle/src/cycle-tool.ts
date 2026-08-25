import { randomUUID } from "node:crypto"

import { tool, type ToolDefinition } from "./tool-runtime.js"

import type { GoalControlAction, WorkflowControlPlane } from "./control-plane.js"
import { renderCycleHelp } from "./help.js"
import type { WorkflowRole } from "./permissions.js"
import { PRODUCT_NAME } from "./product.js"

export interface SetupInspector {
  inspect(sessionId: string): Promise<unknown>
  inspectGit?(): Promise<unknown> | unknown
  inspectHost?(): Promise<unknown> | unknown
  inspectLimits?(): Promise<unknown> | unknown
  inspectModels?(sessionId: string, role?: WorkflowRole, model?: string): Promise<unknown> | unknown
  inspectPermissions?(): Promise<unknown> | unknown
  pendingRequest?(sessionId: string): string | undefined
  recoverRetry?(
    sessionId: string,
    result: unknown,
    signal: AbortSignal,
  ): Promise<unknown> | unknown
  run?(
    sessionId: string,
    mode: "auto" | "full" | "quick",
    goalId?: string,
    milestone?: string,
    signal?: AbortSignal,
  ): Promise<unknown> | unknown
  setRoutingPreference?(sessionId: string, mode: "auto" | "full" | "quick"): Promise<unknown> | unknown
}

export const GOAL_OPERATIONS = [
  "goal_create",
  "goal_amend",
  "goal_status",
  "goal_list",
  "goal_focus",
  "goal_save_plan",
  "goal_link_workflow",
  "goal_transition",
] as const

export const GOAL_TRANSITIONS: readonly GoalControlAction[] = [
  "start_planning",
  "mark_ready",
  "activate",
  "pause",
  "resume",
  "block",
  "resume_blocked",
  "continue",
  "request_completion",
  "approve_completion",
  "reject_completion",
  "abort",
]

export function cycleControlTool(
  controlPlane: WorkflowControlPlane,
  projectKey: string,
  setupInspector?: SetupInspector,
): ToolDefinition {
  return tool({
    description: `Run, inspect and control ${PRODUCT_NAME} through native OpenCode state.`,
    args: {
      afterSequence: tool.schema.number().int().nonnegative().optional(),
      confirmed: tool.schema.boolean().optional(),
      confidence: tool.schema.enum(["inferred", "user_asserted", "verified"]).optional(),
      completionEvidence: tool.schema.string().regex(/^[0-9a-f]{64}$/u).optional(),
      constraints: tool.schema.array(tool.schema.string().min(1)).max(100).optional(),
      document: tool.schema.string().min(1).optional(),
      goalId: tool.schema.string().uuid().optional(),
      limit: tool.schema.number().int().min(1).max(1_000).optional(),
      memoryId: tool.schema.string().uuid().optional(),
      milestone: tool.schema.string().min(1).max(256).optional(),
      mode: tool.schema.enum(["auto", "quick", "full"]).optional(),
      model: tool.schema.string().min(3).optional(),
      nonGoals: tool.schema.array(tool.schema.string().min(1)).max(100).optional(),
      operation: tool.schema.enum([
        "setup",
        "run",
        "status",
        "tasks",
        "evidence",
        "models",
        "permissions",
        "limits",
        "pause",
        "resume",
        "cancel",
        "retry",
        "history",
        "history_verify",
        "export",
        "memory_search",
        "memory_explain",
        "memory_remove",
        ...GOAL_OPERATIONS,
        "doctor",
        "help",
      ]),
      reason: tool.schema.string().min(1).max(4_096).optional(),
      role: tool.schema
        .enum(["architect", "executor", "functional_reviewer", "security_reviewer", "arbiter"])
        .optional(),
      scope: tool.schema.string().min(1).optional(),
      successCriteria: tool.schema.array(tool.schema.string().min(1)).min(1).max(100).optional(),
      text: tool.schema.string().optional(),
      transition: tool.schema.enum(GOAL_TRANSITIONS).optional(),
      workflowId: tool.schema.string().uuid().optional(),
    },
    async execute(args, context) {
      if (["cancel", "export", "memory_remove"].includes(args.operation) && args.confirmed !== true) {
        throw new Error("This operation requires confirmed=true after explicit user approval")
      }
      if (["memory_explain", "memory_remove"].includes(args.operation) && !args.memoryId) {
        throw new Error("This operation requires memoryId")
      }
      if (args.operation === "setup") {
        if (setupInspector === undefined) {
          throw new Error("Native setup inspection is unavailable on this host")
        }
        return {
          output: JSON.stringify(await setupInspector.inspect(context.sessionID), null, 2),
          title: `${PRODUCT_NAME} setup`,
        }
      }
      if (args.operation === "run") {
        if (setupInspector?.run !== undefined) {
          if ((args.goalId === undefined) !== (args.milestone === undefined)) {
            throw new Error("Goal-linked runs require both goalId and milestone")
          }
          const result = await setupInspector.run(
            context.sessionID,
            args.mode ?? "auto",
            args.goalId,
            args.milestone,
            context.abort,
          )
          return { output: JSON.stringify(result, null, 2), title: `${PRODUCT_NAME} started` }
        }
        if (setupInspector?.setRoutingPreference === undefined) {
          throw new Error("Native routing configuration is unavailable on this host")
        }
        const result = await setupInspector.setRoutingPreference(context.sessionID, args.mode ?? "auto")
        return { output: JSON.stringify(result, null, 2), title: `${PRODUCT_NAME} routing` }
      }
      if (args.operation === "models") {
        if (setupInspector?.inspectModels === undefined) {
          throw new Error("Native model configuration is unavailable on this host")
        }
        const result = await setupInspector.inspectModels(context.sessionID, args.role, args.model)
        return { output: JSON.stringify(result, null, 2), title: `${PRODUCT_NAME} models` }
      }
      if (args.operation === "permissions" || args.operation === "limits") {
        const inspect =
          args.operation === "permissions"
            ? setupInspector?.inspectPermissions
            : setupInspector?.inspectLimits
        if (inspect === undefined) throw new Error(`Native ${args.operation} inspection is unavailable`)
        return {
          output: JSON.stringify(await inspect(), null, 2),
          title: `${PRODUCT_NAME} ${args.operation}`,
        }
      }
      if (args.operation === "help") {
        const host = setupInspector?.inspectHost === undefined ? undefined : await setupInspector.inspectHost()
        return { output: renderCycleHelp(host), title: `${PRODUCT_NAME} help` }
      }
      if (args.operation.startsWith("goal_")) {
        const result = await executeGoalOperation(controlPlane, projectKey, setupInspector, args, context)
        return {
          output: JSON.stringify(result, null, 2),
          title: `${PRODUCT_NAME} ${args.operation.replaceAll("_", " ")}`,
        }
      }
      if (["status", "tasks", "evidence", "pause", "resume", "cancel", "retry", "doctor"].includes(args.operation)) {
        let result = await controlPlane.control(
          projectKey,
          args.operation as "status" | "tasks" | "evidence" | "pause" | "resume" | "cancel" | "retry" | "doctor",
          args.workflowId,
        )
        if (args.operation === "retry" && setupInspector?.recoverRetry !== undefined) {
          result = await setupInspector.recoverRetry(context.sessionID, result, context.abort)
        }
        if (args.operation === "doctor") {
          const extras: Record<string, unknown> = {}
          if (setupInspector?.inspectHost !== undefined) extras.host = await setupInspector.inspectHost()
          if (setupInspector?.inspectGit !== undefined) extras.git = await setupInspector.inspectGit()
          if (Object.keys(extras).length > 0) {
            result =
              typeof result === "object" && result !== null && !Array.isArray(result)
                ? { ...result, ...extras }
                : { control: result, ...extras }
          }
        }
        return {
          output: JSON.stringify(result, null, 2),
          title: `${PRODUCT_NAME} ${args.operation}`,
        }
      }
      if (args.operation.startsWith("memory_")) {
        const operation =
          args.operation === "memory_search"
            ? {
                confidence: args.confidence ?? null,
                limit: args.limit ?? 100,
                scope: args.scope ?? null,
                text: args.text ?? "",
                type: "search" as const,
              }
            : {
                memory_id: args.memoryId as string,
                type: args.operation === "memory_remove" ? ("remove" as const) : ("explain" as const),
              }
        const result = await controlPlane.memory(projectKey, operation)
        return {
          output: JSON.stringify(result, null, 2),
          title: `${PRODUCT_NAME} ${args.operation.replaceAll("_", " ")}`,
        }
      }
      const operation =
        args.operation === "history"
          ? {
              after_sequence: args.afterSequence ?? null,
              limit: args.limit ?? 100,
              type: "query" as const,
            }
          : { type: args.operation === "export" ? ("export" as const) : ("verify" as const) }
      const result = await controlPlane.history(projectKey, operation)
      return {
        output: JSON.stringify(result, null, 2),
        title: `${PRODUCT_NAME} ${args.operation.replaceAll("_", " ")}`,
      }
    },
  })
}

async function executeGoalOperation(
  controlPlane: WorkflowControlPlane,
  projectKey: string,
  setupInspector: SetupInspector | undefined,
  args: {
    readonly completionEvidence?: string | undefined
    readonly constraints?: readonly string[] | undefined
    readonly document?: string | undefined
    readonly goalId?: string | undefined
    readonly milestone?: string | undefined
    readonly nonGoals?: readonly string[] | undefined
    readonly operation: string
    readonly reason?: string | undefined
    readonly successCriteria?: readonly string[] | undefined
    readonly transition?: GoalControlAction | undefined
    readonly workflowId?: string | undefined
  },
  context: {
    readonly sessionID: string
    ask(input: {
      readonly always: readonly string[]
      readonly metadata: Record<string, unknown>
      readonly patterns: readonly string[]
      readonly permission: string
    }): Promise<void>
  },
): Promise<unknown> {
  if (args.operation === "goal_create") {
    const objective = requirePendingRequest(setupInspector, context.sessionID)
    if (args.successCriteria === undefined) {
      throw new Error("Goal creation requires at least one explicit success criterion")
    }
    await askGoalApproval(context, "create", { objective })
    return controlPlane.goal(projectKey, {
      constraints: args.constraints ?? [],
      goal_id: randomUUID(),
      max_continuations: 5,
      non_goals: args.nonGoals ?? [],
      objective,
      session_id: context.sessionID,
      success_criteria: args.successCriteria,
      type: "create",
    })
  }
  if (args.operation === "goal_list") return controlPlane.goal(projectKey, { type: "list" })
  if (args.operation === "goal_status") {
    return controlPlane.goal(projectKey, {
      goal_id: args.goalId ?? null,
      session_id: context.sessionID,
      type: "status",
    })
  }
  const goalId = required(args.goalId, "This goal operation requires goalId")
  if (args.operation === "goal_amend") {
    return controlPlane.goal(projectKey, {
      goal_id: goalId,
      operation_id: randomUUID(),
      text: requirePendingRequest(setupInspector, context.sessionID),
      type: "amend",
    })
  }
  if (args.operation === "goal_focus") {
    return controlPlane.goal(projectKey, {
      goal_id: goalId,
      session_id: context.sessionID,
      type: "focus",
    })
  }
  if (args.operation === "goal_save_plan") {
    return controlPlane.goal(projectKey, {
      content: required(args.document, "Saving a goal plan requires document"),
      goal_id: goalId,
      source_session_id: context.sessionID,
      type: "save_plan",
    })
  }
  if (args.operation === "goal_link_workflow") {
    return controlPlane.goal(projectKey, {
      goal_id: goalId,
      milestone: required(args.milestone, "Linking a workflow requires milestone"),
      type: "link_workflow",
      workflow_id: required(args.workflowId, "Linking a workflow requires workflowId"),
    })
  }
  if (args.operation !== "goal_transition") throw new Error("Unsupported goal operation")
  const transition = required(args.transition, "Goal transition requires transition")
  if (["mark_ready", "activate", "request_completion", "approve_completion", "abort"].includes(transition)) {
    await askGoalApproval(context, transition, { goalId })
  }
  return controlPlane.goal(projectKey, {
    action: transition,
    completion_evidence: completionEvidence(args.completionEvidence),
    goal_id: goalId,
    operation_id: randomUUID(),
    reason: args.reason ?? null,
    type: "control",
  })
}

function completionEvidence(value: string | undefined): string | null {
  if (value === undefined) return null
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("Goal completion evidence must be a lowercase SHA-256 digest")
  }
  return value
}

function requirePendingRequest(
  setupInspector: SetupInspector | undefined,
  sessionId: string,
): string {
  const request = setupInspector?.pendingRequest?.(sessionId)
  if (request === undefined) {
    throw new Error("Send the exact goal objective or amendment as a user message before this operation")
  }
  return request
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

async function askGoalApproval(
  context: Parameters<typeof executeGoalOperation>[4],
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await context.ask({
    always: [],
    metadata: { action, ...metadata },
    patterns: [action],
    permission: "opencode-cycle.goal",
  })
}
