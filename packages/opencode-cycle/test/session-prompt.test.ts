import { describe, expect, test } from "bun:test"

import type { PluginInput } from "@opencode-ai/plugin"

import { promptSessionAndWait } from "../src/orchestration/session-prompt.js"

describe("session prompt polling", () => {
  test("keeps long-running role prompts off the blocking message endpoint", async () => {
    let accepted = false
    let messageCalls = 0
    let statusCalls = 0
    let promptCalls = 0
    const client = {
      session: {
        async messages() {
          messageCalls += 1
          if (!accepted) return { data: [] }
          if (statusCalls < 2) return { data: [] }
          return {
            data: [
              {
                info: {
                  id: "assistant-new",
                  role: "assistant",
                  time: { completed: 20, created: 10 },
                },
                parts: [{ text: "completed", type: "text" }],
              },
            ],
          }
        },
        async prompt() {
          promptCalls += 1
          throw new Error("blocking prompt must not be used")
        },
        async promptAsync() {
          accepted = true
          return { data: undefined }
        },
        async status() {
          statusCalls += 1
          return { data: { child: { type: statusCalls < 2 ? "busy" : "idle" } } }
        },
      },
    } as unknown as PluginInput["client"]

    const result = await promptSessionAndWait(
      client,
      {
        body: { parts: [{ text: "work", type: "text" }] },
        path: { id: "child" },
        query: { directory: "C:/repo" },
      },
      { pollIntervalMs: 0 },
    )

    expect(result.parts).toEqual([{ text: "completed", type: "text" }])
    expect(promptCalls).toBe(0)
    expect(statusCalls).toBe(2)
    expect(messageCalls).toBe(2)
  })

  test("fails closed when the completed asynchronous role reports a provider error", async () => {
    let accepted = false
    const client = {
      session: {
        async messages() {
          if (!accepted) return { data: [] }
          return {
            data: [
              {
                info: {
                  error: { data: { message: "redacted" }, name: "UnknownError" },
                  id: "assistant-error",
                  role: "assistant",
                  time: { completed: 20, created: 10 },
                },
                parts: [],
              },
            ],
          }
        },
        async prompt() {
          throw new Error("blocking prompt must not be used")
        },
        async promptAsync() {
          accepted = true
          return { data: undefined }
        },
        async status() {
          return { data: {} }
        },
      },
    } as unknown as PluginInput["client"]

    await expect(
      promptSessionAndWait(
        client,
        {
          body: { parts: [{ text: "work", type: "text" }] },
          path: { id: "child" },
          query: { directory: "C:/repo" },
        },
        { pollIntervalMs: 0 },
      ),
    ).rejects.toThrow("OpenCode role session failed: UnknownError")
  })

  test("aborts an accepted role session when the caller cancels", async () => {
    const controller = new AbortController()
    const reason = new Error("caller stopped")
    let abortCalls = 0
    const client = {
      session: {
        async abort() {
          abortCalls += 1
          return { data: true }
        },
        async messages() {
          return { data: [] }
        },
        async prompt() {
          throw new Error("blocking prompt must not be used")
        },
        async promptAsync() {
          return { data: undefined }
        },
        async status() {
          controller.abort(reason)
          return { data: { child: { type: "busy" } } }
        },
      },
    } as unknown as PluginInput["client"]

    await expect(
      promptSessionAndWait(
        client,
        {
          body: { parts: [{ text: "work", type: "text" }] },
          path: { id: "child" },
          query: { directory: "C:/repo" },
          signal: controller.signal,
        },
        { pollIntervalMs: 0 },
      ),
    ).rejects.toBe(reason)
    expect(abortCalls).toBe(1)
  })

  test("aborts an accepted role session after repeated polling failures", async () => {
    const failure = new Error("status down")
    let abortCalls = 0
    let statusCalls = 0
    const client = {
      session: {
        async abort() {
          abortCalls += 1
          return { data: true }
        },
        async messages() {
          return { data: [] }
        },
        async prompt() {
          throw new Error("blocking prompt must not be used")
        },
        async promptAsync() {
          return { data: undefined }
        },
        async status() {
          statusCalls += 1
          throw failure
        },
      },
    } as unknown as PluginInput["client"]

    await expect(
      promptSessionAndWait(
        client,
        {
          body: { parts: [{ text: "work", type: "text" }] },
          path: { id: "child" },
          query: { directory: "C:/repo" },
        },
        { pollIntervalMs: 0 },
      ),
    ).rejects.toBe(failure)
    expect(statusCalls).toBe(6)
    expect(abortCalls).toBe(1)
  })

  test("extends the idle deadline while the role session stays busy", async () => {
    const origin = 1_000_000
    let now = origin
    const realNow = Date.now
    Date.now = () => now
    let accepted = false
    let statusCalls = 0
    try {
      const client = {
        session: {
          async messages() {
            if (!accepted || statusCalls < 5) return { data: [] }
            return {
              data: [
                {
                  info: {
                    id: "assistant-late",
                    role: "assistant",
                    time: { completed: 80, created: 10 },
                  },
                  parts: [{ text: "completed", type: "text" }],
                },
              ],
            }
          },
          async prompt() {
            throw new Error("blocking prompt must not be used")
          },
          async promptAsync() {
            accepted = true
            return { data: undefined }
          },
          async status() {
            statusCalls += 1
            now += 100
            return { data: { child: { type: statusCalls < 5 ? "busy" : "idle" } } }
          },
        },
      } as unknown as PluginInput["client"]

      const result = await promptSessionAndWait(
        client,
        {
          body: { parts: [{ text: "work", type: "text" }] },
          path: { id: "child" },
          query: { directory: "C:/repo" },
        },
        { absoluteWaitMs: 2_000, maximumWaitMs: 150, pollIntervalMs: 0 },
      )
      expect(result.parts).toEqual([{ text: "completed", type: "text" }])
      expect(statusCalls).toBeGreaterThanOrEqual(5)
      expect(now - origin).toBeGreaterThan(150)
    } finally {
      Date.now = realNow
    }
  })
})
