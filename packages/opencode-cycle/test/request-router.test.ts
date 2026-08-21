import { expect, test } from "bun:test"

import { activeWorkflowForSession, RequestRouter } from "../src/request-router.js"

const request = {
  attachmentHashes: ["a".repeat(64)],
  originalRequest: "Build the exact requested product",
}

test("ordinary messages remain available for consultation without starting a workflow", () => {
  const router = new RequestRouter()

  router.capture("session", request)

  expect(router.takeArmed("session")).toBeUndefined()
  expect(router.pending("session")).toEqual(request)
})

test("an explicitly armed mode starts the next exact request once", () => {
  const router = new RequestRouter()
  router.arm("session", "full")
  router.capture("session", request)

  expect(router.takeArmed("session")).toEqual({ captured: request, preference: "full" })
  expect(router.takeArmed("session")).toBeUndefined()
  expect(router.pending("session")).toBeUndefined()
})

test("a tool-selected mode consumes the pending request and overrides auto routing", () => {
  const router = new RequestRouter()
  router.arm("session", "auto")
  router.capture("session", request)

  expect(router.take("session", "quick")).toEqual({ captured: request, preference: "quick" })
  expect(router.take("session", "full")).toBeUndefined()
})

test("a native run command never consumes the previous advisory request", () => {
  const router = new RequestRouter()
  const implementation = {
    attachmentHashes: [],
    originalRequest: "Implement the next exact request",
  }

  router.capture("session", request)
  router.arm("session", "quick")

  expect(router.takeUnarmed("session", "quick")).toBeUndefined()
  expect(router.pending("session")).toEqual(request)

  router.capture("session", implementation)
  expect(router.takeArmed("session")).toEqual({ captured: implementation, preference: "quick" })
})

test("a redundant run resolves the active workflow instead of rearming routing", () => {
  const workflows = new Map([
    ["active-session", "active-workflow"],
    ["settled-session", "settled-workflow"],
  ])
  const active = new Set(["active-workflow"])

  expect(activeWorkflowForSession("active-session", workflows, active)).toBe("active-workflow")
  expect(activeWorkflowForSession("settled-session", workflows, active)).toBeUndefined()
  expect(activeWorkflowForSession("unknown-session", workflows, active)).toBeUndefined()
})
