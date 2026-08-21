import { describe, expect, test } from "bun:test"

import { effectiveRolePermissions } from "../src/permissions.js"

describe("permission presets", () => {
  test("Safe restricts native allows but preserves native denies", () => {
    const policy = effectiveRolePermissions(
      { bash: "allow", edit: "deny", webfetch: "allow" },
      "safe",
      "executor",
    )
    expect(policy.bash).toBe("ask")
    expect(policy.edit).toBe("deny")
    expect(policy.webfetch).toBe("ask")
  })

  test("Autonomous never elevates native policy", () => {
    const policy = effectiveRolePermissions(
      { "*": "deny", bash: "ask", edit: "deny" },
      "autonomous",
      "executor",
    )
    expect(policy).toEqual({ external_directory: "deny", task: "deny" })
  })

  test("non-writing roles always deny edits and external directories", () => {
    for (const role of ["architect", "functional_reviewer", "security_reviewer", "arbiter"] as const) {
      const policy = effectiveRolePermissions({ "*": "allow" }, "autonomous", role)
      expect(policy.edit).toBe("deny")
      expect(policy.external_directory).toBe("deny")
      expect(policy.task).toBe("deny")
    }
  })

  test("every role denies unmanaged subagent delegation", () => {
    for (const role of [
      "architect",
      "executor",
      "functional_reviewer",
      "security_reviewer",
      "arbiter",
    ] as const) {
      expect(effectiveRolePermissions({}, "balanced", role).task).toBe("deny")
    }
  })

  test("granular native rules remain equally or more restrictive", () => {
    const policy = effectiveRolePermissions(
      { bash: { "*": "allow", "git status *": "allow", "git push *": "deny" } },
      "safe",
      "executor",
    )
    expect(policy.bash).toEqual({ "*": "ask", "git status *": "ask", "git push *": "deny" })
  })

  test("external tool rules inherit the caller restrictions", () => {
    const policy = effectiveRolePermissions(
      { custom_mcp_read: "deny", custom_mcp_write: "allow" },
      "safe",
      "executor",
    )
    expect(policy.custom_mcp_read).toBe("deny")
    expect(policy.custom_mcp_write).toBe("ask")
  })
})
