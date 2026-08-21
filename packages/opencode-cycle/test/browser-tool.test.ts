import { expect, test } from "bun:test"

import { assertBrowserCommandRole, cycleBrowserTool } from "../src/browser/browser-tool.js"

test("browser tool routes through native approval and never returns filled values", async () => {
  const calls: unknown[] = []
  const approvals: unknown[] = []
  const definition = cycleBrowserTool({
    execute(sessionId, command, approve) {
      calls.push({ command, sessionId })
      return approve("https://staging.example.com").then(() => ({ action: "fill", filled: true }))
    },
  })
  const result = await definition.execute(
    { operation: "fill", selector: "#email", value: "test@example.com" },
    {
      abort: new AbortController().signal,
      agent: "Cycle Executor",
      ask: async (request: unknown) => approvals.push(request),
      directory: "C:/project",
      messageID: "message",
      metadata() {},
      sessionID: "session",
      worktree: "C:/project",
    },
  )

  expect(calls).toEqual([
    {
      command: { operation: "fill", selector: "#email", value: "test@example.com" },
      sessionId: "session",
    },
  ])
  expect(approvals).toHaveLength(1)
  expect(result.output).not.toContain("test@example.com")
})

test("interactive browser actions are restricted to governed executor sessions", () => {
  expect(() => assertBrowserCommandRole(undefined, { operation: "click" })).toThrow(
    "orchestrator-authorized executor",
  )
  expect(() => assertBrowserCommandRole("functional_reviewer", { operation: "fill" })).toThrow(
    "orchestrator-authorized executor",
  )
  expect(() => assertBrowserCommandRole("executor", { operation: "click" })).not.toThrow()
  expect(() => assertBrowserCommandRole("architect", { operation: "snapshot" })).not.toThrow()
})
