import { expect, test } from "bun:test"

import { lifecycleMessage, type LifecycleState } from "../src/messages.js"

const states: readonly LifecycleState[] = ["working", "paused", "blocked", "failed", "completed"]

test("messages name every lifecycle state without relying on color", () => {
  for (const state of states) {
    const message = lifecycleMessage(state)
    expect(message.summary.toLowerCase()).toStartWith(state)
    expect(message.summary).not.toMatch(/#[0-9a-f]{3,8}|\b(?:red|green|yellow)\b/iu)
  }
})

test("screen-reader text is actionable for every state", () => {
  for (const state of states) {
    const message = lifecycleMessage(state)
    expect(message.screenReaderText.length).toBeGreaterThan(20)
    expect(message.action.length).toBeGreaterThan(20)
    const lead = message.action.split(/\s+/u).slice(0, 3).join(" ")
    expect(message.screenReaderText.startsWith(lead)).toBeTrue()
  }
})

test("normal progress remains concise", () => {
  const message = lifecycleMessage("working")
  expect(`${message.summary} ${message.action}`.length).toBeLessThan(180)
})
