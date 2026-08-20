import type { WorkflowRole } from "./permissions.js"
import { CYCLE_TOOL_NAMES } from "./product.js"

const READ_ONLY_TOOLS = new Set([
  "codesearch",
  "glob",
  "grep",
  "list",
  "lsp",
  "read",
  "skill",
  "webfetch",
  "websearch",
])

const ENTRYPOINT_TOOLS = new Set(["question", CYCLE_TOOL_NAMES.control, CYCLE_TOOL_NAMES.role])

interface PolicyMaps {
  readonly authorized: Map<string, WorkflowRole>
  readonly direct: Map<string, WorkflowRole>
  readonly entrypoints: Set<string>
}

const namespaces = new Map<string, PolicyMaps>()

function mapsFor(namespace: string): PolicyMaps {
  const existing = namespaces.get(namespace)
  if (existing !== undefined) return existing
  const created = {
    authorized: new Map<string, WorkflowRole>(),
    direct: new Map<string, WorkflowRole>(),
    entrypoints: new Set<string>(),
  }
  namespaces.set(namespace, created)
  return created
}

export class RoleSessionPolicy {
  readonly #maps: PolicyMaps

  constructor(namespace = "") {
    this.#maps = mapsFor(namespace)
  }

  authorize(sessionId: string, role: WorkflowRole): void {
    this.#maps.direct.delete(sessionId)
    this.#maps.entrypoints.delete(sessionId)
    this.#maps.authorized.set(sessionId, role)
  }

  markDirect(sessionId: string, role: WorkflowRole): void {
    if (!this.#maps.authorized.has(sessionId)) this.#maps.direct.set(sessionId, role)
  }

  markEntrypoint(sessionId: string): void {
    this.#maps.authorized.delete(sessionId)
    this.#maps.direct.delete(sessionId)
    this.#maps.entrypoints.add(sessionId)
  }

  revoke(sessionId: string): void {
    this.#maps.authorized.delete(sessionId)
    this.#maps.direct.delete(sessionId)
    this.#maps.entrypoints.delete(sessionId)
  }

  role(sessionId: string): WorkflowRole | undefined {
    return this.#maps.authorized.get(sessionId) ?? this.#maps.direct.get(sessionId)
  }

  assertToolAllowed(sessionId: string, tool: string): void {
    if (this.#maps.entrypoints.has(sessionId) && !ENTRYPOINT_TOOLS.has(tool)) {
      throw new Error("The Cycle entrypoint can only invoke native orchestration tools.")
    }
    if (this.#maps.direct.has(sessionId) && !READ_ONLY_TOOLS.has(tool)) {
      throw new Error(
        "Direct role sessions are advisory and read-only. Start a governed workflow to execute tools.",
      )
    }
    const role = this.#maps.authorized.get(sessionId)
    if (role === "executor" && (tool === CYCLE_TOOL_NAMES.control || tool === CYCLE_TOOL_NAMES.role)) {
      throw new Error("The authorized executor cannot invoke Cycle orchestration tools.")
    }
    if (role !== undefined && role !== "executor" && !READ_ONLY_TOOLS.has(tool)) {
      throw new Error(`The authorized ${role} session is read-only.`)
    }
  }
}
