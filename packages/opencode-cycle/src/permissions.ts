export type PermissionDecision = "allow" | "ask" | "deny"
export type PermissionRule = PermissionDecision | Readonly<Record<string, PermissionDecision>>
export type PermissionPolicy = Readonly<Record<string, PermissionRule | undefined>>
export type PermissionPreset = "safe" | "balanced" | "autonomous"
export type WorkflowRole =
  | "architect"
  | "executor"
  | "functional_reviewer"
  | "security_reviewer"
  | "arbiter"

/**
 * Every name a host may use for the permission that lets a session delegate work to another one.
 *
 * Denying one name is a boundary that expires the day the host renames it, and it expires in
 * silence: nothing fails, the rule simply stops matching. The Claude Code port lost its subagent
 * boundary exactly that way when `Task` became `Agent`, and the other layers held so there was no
 * symptom. All of these are refused, and `delegationBoundaryGap` reports a host whose policy names
 * none of them.
 */
export const DELEGATION_KEYS = ["agent", "subagent", "task"] as const

/**
 * Whether this build's delegation deny can reach the host at all: the host offers child sessions
 * and its permission policy carries none of the names this build refuses. An absent finding means
 * a key was matched, not that delegation is impossible — it is the difference between a boundary
 * that was checked and one that was assumed.
 */
export function delegationBoundaryGap(
  offersChildSessions: boolean,
  nativePolicy: PermissionPolicy,
): string | undefined {
  if (!offersChildSessions) return undefined
  const known = Object.keys(nativePolicy).filter((key) =>
    (DELEGATION_KEYS as readonly string[]).includes(key),
  )
  if (known.length > 0) return undefined
  return (
    "This host offers child sessions and its permission policy names none of " +
    `${DELEGATION_KEYS.join(", ")}. Cycle still denies all of those for every role, and the ` +
    "other two separation layers are unaffected, but the permission layer cannot be confirmed to " +
    "apply. Report the key this host uses for delegation."
  )
}

const rank: Readonly<Record<PermissionDecision, number>> = { deny: 0, ask: 1, allow: 2 }
const readOnlyRoles: readonly WorkflowRole[] = [
  "architect",
  "functional_reviewer",
  "security_reviewer",
  "arbiter",
]

function stricter(left: PermissionDecision, right: PermissionDecision): PermissionDecision {
  return rank[left] <= rank[right] ? left : right
}

function restrictRule(
  rule: PermissionRule | undefined,
  ceiling: PermissionDecision,
  fallback: PermissionDecision,
): PermissionRule {
  if (typeof rule === "string") return stricter(rule, ceiling)
  if (rule === undefined) return stricter(fallback, ceiling)

  const restricted: Record<string, PermissionDecision> = {
    "*": stricter(rule["*"] ?? fallback, ceiling),
  }
  for (const [pattern, decision] of Object.entries(rule)) {
    if (pattern !== "*") restricted[pattern] = stricter(decision, ceiling)
  }
  return restricted
}

function presetCeiling(preset: PermissionPreset, key: string): PermissionDecision | undefined {
  if (preset === "autonomous") return undefined
  if (key === "external_directory") return "deny"
  if (preset === "safe") return key === "doom_loop" ? "deny" : "ask"
  return key === "doom_loop" ? "ask" : undefined
}

export function effectiveRolePermissions(
  nativePolicy: PermissionPolicy,
  preset: PermissionPreset,
  role: WorkflowRole,
): Readonly<Record<string, PermissionRule>> {
  const result: Record<string, PermissionRule> = {}
  const fallbackRule = nativePolicy["*"]
  const fallback = typeof fallbackRule === "string" ? fallbackRule : "allow"

  for (const [key, rule] of Object.entries(nativePolicy)) {
    const ceiling = presetCeiling(preset, key)
    if (ceiling !== undefined) result[key] = restrictRule(rule, ceiling, fallback)
  }

  for (const key of ["bash", "doom_loop", "external_directory", "webfetch"]) {
    const ceiling = presetCeiling(preset, key)
    if (ceiling !== undefined && result[key] === undefined) {
      result[key] = restrictRule(nativePolicy[key], ceiling, fallback)
    }
  }

  if (readOnlyRoles.includes(role)) {
    result.edit = "deny"
    result.external_directory = "deny"
  } else {
    result.external_directory = "deny"
  }
  for (const key of DELEGATION_KEYS) result[key] = "deny"

  return result
}
