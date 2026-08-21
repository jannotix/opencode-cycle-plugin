import { expect, test } from "bun:test"

import { RoleConsultations } from "../src/orchestration/role-consultation.js"

test("architect consultation is multi-turn, exact-request based and read-only", async () => {
  const prompts: unknown[] = []
  const registered: unknown[] = []
  let creates = 0
  const client = {
    session: {
      async create() {
        creates += 1
        return { data: { id: "architect-session" } }
      },
      async prompt(input: unknown) {
        prompts.push(input)
        return { data: { parts: [{ text: "Architecture advice", type: "text" }] } }
      },
    },
  }
  const consultations = new RoleConsultations(client as never, {
    directory: "C:/project",
    goalSnapshot: async () => ({ goalId: "goal", objective: "Ship a SaaS" }),
    models: { architect: "provider/architect" },
    onSessionCreated(sessionId, role) {
      registered.push({ role, sessionId })
    },
  })

  const first = await consultations.invoke("parent", "architect_consult", "First exact question")
  await consultations.invoke("parent", "architect_consult", "Second exact question")

  expect(creates).toBe(1)
  expect(registered).toEqual([{ role: "architect", sessionId: "architect-session" }])
  expect(JSON.stringify(prompts[0])).toContain("First exact question")
  expect(JSON.stringify(prompts[1])).toContain("Second exact question")
  expect(JSON.stringify(prompts[0])).toContain("provider")
  expect(JSON.stringify(prompts[0])).toContain("You may inspect but must not edit")
  expect(first).toMatchObject({ model: "provider/architect" })
})

test("executor standalone access is feasibility analysis rather than unreviewed execution", async () => {
  const prompts: unknown[] = []
  const consultations = new RoleConsultations(
    {
      session: {
        async create() {
          return { data: { id: "executor-session" } }
        },
        async prompt(input: unknown) {
          prompts.push(input)
          return { data: { parts: [{ text: "Feasible", type: "text" }] } }
        },
      },
    } as never,
    { directory: "C:/project", goalSnapshot: async () => null, models: {} },
  )

  await consultations.invoke("parent", "executor_feasibility", "Assess this task")

  expect(JSON.stringify(prompts[0])).toContain("Do not execute commands or modify files")
})

test("standalone consultation forwards cancellation to child session calls", async () => {
  const calls: { readonly signal?: AbortSignal }[] = []
  const controller = new AbortController()
  const consultations = new RoleConsultations(
    {
      session: {
        async create(input: { signal?: AbortSignal }) {
          calls.push(input)
          return { data: { id: "cancelled-session" } }
        },
        async prompt(input: { signal?: AbortSignal }) {
          calls.push(input)
          return { data: { parts: [{ text: "Advice", type: "text" }] } }
        },
      },
    } as never,
    { directory: "C:/project", goalSnapshot: async () => null, models: {} },
  )

  await consultations.invoke("parent", "architect_consult", "Assess this task", controller.signal)

  expect(calls).toHaveLength(2)
  expect(calls.every((call) => call.signal === controller.signal)).toBeTrue()
})

test("asynchronous consultation aborts its child exactly once on caller cancellation", async () => {
  const controller = new AbortController()
  const reason = new Error("consultation stopped")
  let abortCalls = 0
  const consultations = new RoleConsultations(
    {
      session: {
        async abort() {
          abortCalls += 1
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
    } as never,
    { directory: "C:/project", goalSnapshot: async () => null, models: {} },
  )

  await expect(
    consultations.invoke("parent", "architect_consult", "Assess this task", controller.signal),
  ).rejects.toBe(reason)
  expect(abortCalls).toBe(1)
})
