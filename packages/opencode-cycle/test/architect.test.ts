import { expect, test } from "bun:test"

import { runArchitect } from "../src/orchestration/architect.js"

function client(output: unknown, calls: unknown[]) {
  return {
    session: {
      async create(options: unknown) {
        calls.push({ create: options })
        return { data: { id: "architect-session" } }
      },
      async prompt(options: unknown) {
        calls.push({ prompt: options })
        return {
          data: {
            parts: [{ text: typeof output === "string" ? output : JSON.stringify(output), type: "text" }],
          },
        }
      },
    },
  }
}

const validOutput = {
  assumptions: [],
  integration_checks: ["Run the complete user journey."],
  requirements: [
    {
      acceptance_criteria: ["The requested behavior works."],
      id: "REQ-1",
      statement: "Implement the requested behavior.",
    },
  ],
  risks: [],
  tasks: [
    {
      acceptance_criteria: ["The bounded change passes verification."],
      dependencies: [],
      key: "implementation",
      objective: "Implement the smallest complete change.",
      requirement_ids: ["REQ-1"],
      title: "Implement behavior",
      verification_commands: ["bun test"],
      write_scopes: ["src"],
    },
  ],
}

test("architect runs in a child session and returns a digest-bound executable plan", async () => {
  const calls: unknown[] = []
  const sessions: string[] = []
  const result = await runArchitect(client(validOutput, calls) as never, {
    codeContext: { nodes: [], paths: ["src/feature.ts"], scopes: ["src"], truncated: false },
    directory: "C:/project",
    model: "provider/model/family",
    onSessionCreated: (session) => sessions.push(session),
    originalRequest: "Build the feature end to end.",
    parentSessionId: "parent-session",
    requestDigest: "a".repeat(64),
  })

  expect(sessions).toEqual(["architect-session"])
  expect(result.plan.request_digest).toBe("a".repeat(64))
  expect(result.plan.tasks[0]?.id).toMatch(/^[0-9a-f-]{36}$/u)
  expect(calls[0]).toEqual({
    create: {
      body: { parentID: "parent-session", title: "Cycle Architect" },
      query: { directory: "C:/project" },
    },
  })
  expect(JSON.stringify(calls[1])).toContain('"providerID":"provider"')
  expect(JSON.stringify(calls[1])).toContain('"modelID":"model/family"')
  expect(JSON.stringify(calls[1])).toContain("Build the feature end to end.")
  expect(JSON.stringify(calls[1])).toContain("src/feature.ts")
  expect(JSON.stringify(calls[1])).toContain(
    "Requirements must describe outcomes that the frozen candidate and deterministic verification evidence can establish",
  )
  expect(JSON.stringify(calls[1])).toContain(
    "independent reviews, arbitration, delivery, goal linking or goal completion",
  )
  expect(JSON.stringify(calls[1])).toContain(
    "base_revision, exact file manifest and candidate-integrity evidence",
  )
})

test("architect output fails closed on prose, unknown fields and dependencies", async () => {
  expect(
    runArchitect(client("```json\n{}\n```", []) as never, {
      directory: "C:/project",
      model: null,
      originalRequest: "Request",
      parentSessionId: "parent",
      requestDigest: "b".repeat(64),
    }),
  ).rejects.toThrow("one valid JSON object")

  expect(
    runArchitect(
      client(
        {
          ...validOutput,
          tasks: [{ ...validOutput.tasks[0], dependencies: ["missing"] }],
        },
        [],
      ) as never,
      {
        directory: "C:/project",
        model: null,
        originalRequest: "Request",
        parentSessionId: "parent",
        requestDigest: "b".repeat(64),
      },
    ),
  ).rejects.toThrow("unknown dependency")
})

test("architect rejects plans that the native control plane cannot deserialize", async () => {
  expect(
    runArchitect(
      client(
        {
          ...validOutput,
          tasks: [{ ...validOutput.tasks[0], write_scopes: [] }],
        },
        [],
      ) as never,
      {
        directory: "C:/project",
        model: null,
        originalRequest: "Request",
        parentSessionId: "parent",
        requestDigest: "c".repeat(64),
      },
    ),
  ).rejects.toThrow("at least one write scope")

  await expect(
    runArchitect(
      client(
        {
          ...validOutput,
          tasks: [{ ...validOutput.tasks[0], verification_commands: ["git diff -- src"] }],
        },
        [],
      ) as never,
      {
        directory: "C:/project",
        model: null,
        originalRequest: "Request",
        parentSessionId: "parent",
        requestDigest: "c".repeat(64),
      },
    ),
  ).rejects.toThrow("unsafe verification command")
})

test("architect aborts its asynchronous child session when the workflow is cancelled", async () => {
  const controller = new AbortController()
  const reason = new Error("architect stopped")
  let abortCalls = 0
  const asynchronousClient = {
    session: {
      async abort(options: unknown) {
        abortCalls += 1
        expect(options).toEqual({
          path: { id: "architect-session" },
          query: { directory: "C:/project" },
        })
        return { data: true }
      },
      async create() {
        return { data: { id: "architect-session" } }
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
        return { data: { "architect-session": { type: "busy" } } }
      },
    },
  }

  await expect(
    runArchitect(asynchronousClient as never, {
      directory: "C:/project",
      model: "provider/model",
      originalRequest: "Request",
      parentSessionId: "parent",
      requestDigest: "d".repeat(64),
      signal: controller.signal,
    }),
  ).rejects.toBe(reason)
  expect(abortCalls).toBe(1)
})
