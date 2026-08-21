import { expect, test } from "bun:test"

import { digest, observation } from "../src/audit-events.js"

test("audit digests are stable across object key order", () => {
  expect(digest({ alpha: 1, beta: { x: true, y: false } })).toBe(
    digest({ beta: { y: false, x: true }, alpha: 1 }),
  )
  expect(digest("secret text")).toMatch(/^[0-9a-f]{64}$/u)
})

test("audit observations contain identity and digests without request content", () => {
  const request = "private request content"
  const event = observation(
    {
      model: { modelID: "model", providerID: "provider" },
      projectKey: "project",
      sessionID: "session",
    },
    { action: "request_received", type: "workflow" },
    { request_digest: digest(request) },
  )
  expect(JSON.stringify(event)).not.toContain(request)
  expect(event.model).toEqual({ model: "model", provider: "provider" })
  expect(event.metadata.request_digest).toMatch(/^[0-9a-f]{64}$/u)
})

test("security reviewer uses the canonical IPC role", () => {
  const event = observation(
    { projectKey: "project", role: "security_reviewer" },
    { action: "role_request_received", type: "workflow" },
  )

  expect(event.role).toBe("security_architecture_reviewer")
})
