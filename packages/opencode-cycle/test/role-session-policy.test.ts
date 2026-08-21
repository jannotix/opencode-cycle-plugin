import { expect, test } from "bun:test"

import { RoleSessionPolicy } from "../src/role-session-policy.js"

test("direct role sessions can inspect but cannot execute or mutate", () => {
  const policy = new RoleSessionPolicy()
  policy.markDirect("session", "executor")

  expect(() => policy.assertToolAllowed("session", "read")).not.toThrow()
  expect(() => policy.assertToolAllowed("session", "grep")).not.toThrow()
  expect(() => policy.assertToolAllowed("session", "bash")).toThrow("advisory and read-only")
  expect(() => policy.assertToolAllowed("session", "edit")).toThrow("advisory and read-only")
  expect(() => policy.assertToolAllowed("session", "mcp_database_write")).toThrow(
    "advisory and read-only",
  )
})

test("orchestrator-authorized role sessions retain their configured role permissions", () => {
  const policy = new RoleSessionPolicy()
  policy.markDirect("session", "executor")
  policy.authorize("session", "executor")

  expect(policy.role("session")).toBe("executor")
  expect(() => policy.assertToolAllowed("session", "bash")).not.toThrow()
  expect(() => policy.assertToolAllowed("session", "cycle_control")).toThrow("orchestration tools")
  expect(() => policy.assertToolAllowed("session", "cycle_role")).toThrow("orchestration tools")
})

test("authorized read-only roles cannot mutate through shell or unknown tools", () => {
  const policy = new RoleSessionPolicy()
  policy.authorize("architect", "architect")

  expect(() => policy.assertToolAllowed("architect", "read")).not.toThrow()
  expect(() => policy.assertToolAllowed("architect", "bash")).toThrow("read-only")
  expect(() => policy.assertToolAllowed("architect", "mcp_database_write")).toThrow("read-only")
})

test("cycle entrypoint can only invoke native orchestration tools", () => {
  const policy = new RoleSessionPolicy()
  policy.markEntrypoint("cycle")

  expect(() => policy.assertToolAllowed("cycle", "cycle_control")).not.toThrow()
  expect(() => policy.assertToolAllowed("cycle", "cycle_role")).not.toThrow()
  expect(() => policy.assertToolAllowed("cycle", "bash")).toThrow("entrypoint")
  expect(() => policy.assertToolAllowed("cycle", "mcp_database_write")).toThrow("entrypoint")
})

test("authorization is shared across native plugin instances and can be revoked", () => {
  const sourceInstance = new RoleSessionPolicy()
  const worktreeInstance = new RoleSessionPolicy()
  sourceInstance.authorize("shared-executor", "executor")

  worktreeInstance.markDirect("shared-executor", "executor")
  expect(() => worktreeInstance.assertToolAllowed("shared-executor", "bash")).not.toThrow()

  sourceInstance.revoke("shared-executor")
  worktreeInstance.markDirect("shared-executor", "executor")
  expect(() => worktreeInstance.assertToolAllowed("shared-executor", "bash")).toThrow(
    "advisory and read-only",
  )
  worktreeInstance.revoke("shared-executor")
})

test("authorization is isolated across Cycle data directories", () => {
  const first = new RoleSessionPolicy("C:/cycle-data/one")
  const second = new RoleSessionPolicy("C:/cycle-data/two")
  first.authorize("shared-executor", "executor")
  second.markDirect("shared-executor", "executor")

  expect(() => first.assertToolAllowed("shared-executor", "bash")).not.toThrow()
  expect(() => second.assertToolAllowed("shared-executor", "bash")).toThrow("advisory and read-only")

  first.revoke("shared-executor")
  second.revoke("shared-executor")
})
