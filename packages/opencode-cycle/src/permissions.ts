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
  result.task = "deny"

  return result
}
