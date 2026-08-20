import { createHash } from "node:crypto"

import type { AuditObservation } from "./client.js"

export type AuditData = AuditObservation["data"]

export interface AuditContext {
  readonly candidateID?: string
  readonly files?: readonly string[]
  readonly model?: { readonly modelID: string; readonly providerID: string }
  readonly projectKey: string
  readonly sessionID?: string
  readonly role?: "architect" | "executor" | "functional_reviewer" | "security_reviewer" | "arbiter"
  readonly taskID?: string
  readonly workflowID?: string
}

export function observation(
  context: AuditContext,
  data: AuditData,
  metadata: Readonly<Record<string, string>> = {},
): AuditObservation {
  return {
    actor_id: "opencode-plugin",
    candidate_id: context.candidateID ?? null,
    data,
    evidence_ids: [],
    files: [...(context.files ?? [])],
    metadata,
    model:
      context.model === undefined
        ? null
        : { model: context.model.modelID, provider: context.model.providerID },
    project_key: context.projectKey,
    role:
      context.role === "security_reviewer"
        ? "security_architecture_reviewer"
        : (context.role ?? null),
    session_id: context.sessionID ?? null,
    task_id: context.taskID ?? null,
    timestamp_unix_millis: Date.now(),
    workflow_id: context.workflowID ?? null,
  }
}

export function digest(value: unknown): string {
  const encoded = JSON.stringify(value, objectKeysSorted) ?? "null"
  return createHash("sha256").update(encoded).digest("hex")
}

function objectKeysSorted(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}
