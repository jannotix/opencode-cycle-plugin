import type { CapturedWorkflowRequest } from "./commands/run.js"

export type WorkflowModePreference = "auto" | "full" | "quick"

export interface RoutedWorkflowRequest {
  readonly captured: CapturedWorkflowRequest
  readonly preference: WorkflowModePreference
}

export function activeWorkflowForSession(
  sessionId: string,
  workflows: ReadonlyMap<string, string>,
  activeWorkflowIds: ReadonlySet<string>,
): string | undefined {
  const workflowId = workflows.get(sessionId)
  return workflowId !== undefined && activeWorkflowIds.has(workflowId) ? workflowId : undefined
}

export class RequestRouter {
  readonly #pending = new Map<string, CapturedWorkflowRequest>()
  readonly #preferences = new Map<string, WorkflowModePreference>()

  arm(sessionId: string, preference: WorkflowModePreference): void {
    this.#preferences.set(sessionId, preference)
  }

  capture(sessionId: string, request: CapturedWorkflowRequest): void {
    this.#pending.set(sessionId, request)
  }

  pending(sessionId: string): CapturedWorkflowRequest | undefined {
    return this.#pending.get(sessionId)
  }

  take(sessionId: string, preference?: WorkflowModePreference): RoutedWorkflowRequest | undefined {
    const captured = this.#pending.get(sessionId)
    if (captured === undefined) return undefined
    this.#pending.delete(sessionId)
    const routed = preference ?? this.#preferences.get(sessionId) ?? "auto"
    this.#preferences.delete(sessionId)
    return { captured, preference: routed }
  }

  takeUnarmed(
    sessionId: string,
    preference: WorkflowModePreference,
  ): RoutedWorkflowRequest | undefined {
    if (this.#preferences.has(sessionId)) return undefined
    return this.take(sessionId, preference)
  }

  takeArmed(sessionId: string): RoutedWorkflowRequest | undefined {
    const preference = this.#preferences.get(sessionId)
    return preference === undefined ? undefined : this.take(sessionId, preference)
  }
}
