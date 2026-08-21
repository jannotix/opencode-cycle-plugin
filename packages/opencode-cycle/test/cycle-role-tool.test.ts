import { expect, test } from "bun:test"

import { cycleRoleTool } from "../src/cycle-role-tool.js"

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

test("role tool exposes bounded advisory operations through the native controller", async () => {
  const calls: unknown[] = []
  const definition = cycleRoleTool({
    invoke(sessionId, operation, signal) {
      calls.push({ operation, sessionId, signal })
      return { operation, role: "architect", text: "Use a modular monolith." }
    },
  })

  const result = await definition.execute({ operation: "architect_consult" }, context)

  expect(calls).toEqual([
    { operation: "architect_consult", sessionId: "session", signal: context.abort },
  ])
  expect(result.title).toBe("Cycle for OpenCode architect consult")
  expect(result.output).toContain("modular monolith")
})
