import { expect, spyOn, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import OpenCodeCycle, * as pluginModule from "../src/index.js"
import { LocalControlPlane } from "../src/control-plane.js"

const execFileAsync = promisify(execFile)

async function gitWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cycle-load-"))
  await execFileAsync("git", ["-C", directory, "init"], { windowsHide: true })
  await execFileAsync("git", ["-C", directory, "config", "user.email", "test@example.invalid"], {
    windowsHide: true,
  })
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Test User"], {
    windowsHide: true,
  })
  await execFileAsync("git", ["-C", directory, "config", "core.hooksPath", ".git/hooks"], {
    windowsHide: true,
  })
  await execFileAsync(
    "git",
    ["-C", directory, "commit", "--allow-empty", "--no-verify", "-m", "base"],
    { windowsHide: true },
  )
  return directory
}

function stubNativeReadBoundary() {
  const audit = spyOn(LocalControlPlane.prototype, "audit").mockResolvedValue({
    entryHash: "a".repeat(64),
    sequence: 1,
  })
  const goal = spyOn(LocalControlPlane.prototype, "goal").mockRejectedValue(
    new Error("no focused goal"),
  )
  return () => {
    audit.mockRestore()
    goal.mockRestore()
  }
}

const supportedInput = {
  client: {
    app: { agents() {}, log: async () => ({}) },
    config: { providers() {} },
    session: {
      abort() {},
      children() {},
      create() {},
      prompt() {},
      promptAsync() {},
      status: async () => ({ data: {} }),
    },
  },
}

test("exports a supported OpenCode plugin entrypoint", async () => {
  expect(Object.keys(pluginModule)).toEqual(["default"])
  const hooks = await OpenCodeCycle(supportedInput as never, { hostVersion: "1.18.16" })
  expect(hooks.config).toBeFunction()
  const config = { agent: { plan: { mode: "primary" } }, command: {} }
  await hooks.config?.(config as never)
  expect(config.agent.Cycle?.mode).toBe("primary")
  expect(config.agent["Cycle Executor"]?.mode).toBe("subagent")
  expect(config.agent.WorkFlow).toBeUndefined()
  expect(config.command.cycle?.agent).toBe("Cycle")
  expect(config.command.workflow).toBeUndefined()
  expect(Object.keys(hooks.tool).sort()).toEqual(["cycle_browser", "cycle_control", "cycle_role"])
})

test("duplicate retry tools share one recovery and caller cancellation reaches the orchestrator", async () => {
  const workflowId = "018f47d0-a9b2-7c1d-8a77-123456789abc"
  const candidateId = "018f47d0-a9b2-7c1d-8a77-123456789abd"
  let retryCalls = 0
  let statusCalls = 0
  let promoteCalls = 0
  let releasePromotion: (() => void) | undefined
  const promotionPending = new Promise<void>((resolve) => {
    releasePromotion = resolve
  })
  let secondRetry: (() => void) | undefined
  const secondRetryObserved = new Promise<void>((resolve) => {
    secondRetry = resolve
  })
  const control = spyOn(LocalControlPlane.prototype, "control").mockImplementation(
    async (_projectKey, operation) => {
      if (operation === "retry") {
        retryCalls += 1
        if (retryCalls === 2) secondRetry?.()
        return { state: "delivery", workflowId }
      }
      statusCalls += 1
      return { currentCandidate: candidateId, state: "delivery", workflowId }
    },
  )
  const promote = spyOn(LocalControlPlane.prototype, "promoteCandidate").mockImplementation(
    async () => {
      promoteCalls += 1
      await promotionPending
      return { changedPaths: ["src/app.ts"], workflowState: "completed" }
    },
  )
  const startWorkflow = spyOn(LocalControlPlane.prototype, "startWorkflow").mockRejectedValue(
    new Error("a second workflow must not start during recovery"),
  )
  const restoreNative = stubNativeReadBoundary()
  const hooks = await OpenCodeCycle(supportedInput as never, { hostVersion: "1.18.16" })
  const firstController = new AbortController()
  const secondController = new AbortController()

  try {
    await hooks["chat.message"]?.(
      { agent: "Cycle", sessionID: "first" },
      { parts: [{ text: "Do not start this request during recovery.", type: "text" }] },
    )
    const first = hooks.tool?.cycle_control.execute(
      { operation: "retry", workflowId },
      { abort: firstController.signal, sessionID: "first" },
    )
    while (promoteCalls === 0) await Promise.resolve()
    const duplicate = hooks.tool?.cycle_control.execute(
      { operation: "retry", workflowId },
      { abort: secondController.signal, sessionID: "second" },
    )
    await secondRetryObserved
    await Promise.resolve()
    expect(promoteCalls).toBe(1)
    await expect(
      hooks.tool?.cycle_control.execute(
        { mode: "quick", operation: "run" },
        { sessionID: "first" },
      ),
    ).resolves.toMatchObject({ output: expect.stringContaining(workflowId) })
    expect(startWorkflow).not.toHaveBeenCalled()

    releasePromotion?.()
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    expect(firstResult.output).toBe(duplicateResult.output)
    expect(statusCalls).toBe(2)

    const aborted = new AbortController()
    aborted.abort(new Error("stopped"))
    await expect(
      hooks.tool?.cycle_control.execute(
        { operation: "retry", workflowId },
        { abort: aborted.signal, sessionID: "aborted" },
      ),
    ).rejects.toThrow("stopped")
    expect(promoteCalls).toBe(1)
  } finally {
    releasePromotion?.()
    await hooks.dispose?.()
    restoreNative()
    startWorkflow.mockRestore()
    promote.mockRestore()
    control.mockRestore()
  }
})

test("retry resumes a hung orchestrator that has no busy role sessions", async () => {
  const worktree = await gitWorkspace()
  const workflowId = "018f47d0-a9b2-7c1d-8a77-123456789abc"
  let admissionCalls = 0
  let recoveryStatusCalls = 0
  const control = spyOn(LocalControlPlane.prototype, "control").mockImplementation(
    async (_projectKey, operation) => {
      if (operation === "retry") return { state: "quick_execution", workflowId }
      if (operation === "status") {
        recoveryStatusCalls += 1
        return { state: "completed", workflowId }
      }
      throw new Error(`unexpected control operation ${String(operation)}`)
    },
  )
  const startWorkflow = spyOn(LocalControlPlane.prototype, "startWorkflow").mockResolvedValue({
    mode: "quick",
    requestDigest: "a".repeat(64),
    workflowId,
  })
  const admission = spyOn(LocalControlPlane.prototype, "admission").mockImplementation(async () => {
    admissionCalls += 1
    return {
      active: 0,
      admitted: false,
      leaseExpiresUnixMillis: null,
      maximumActive: 1,
      reason: "busy",
      retryAfterMillis: 60_000,
    }
  })
  const restoreNative = stubNativeReadBoundary()
  const hooks = await OpenCodeCycle(
    { ...supportedInput, directory: worktree, worktree } as never,
    { hostVersion: "1.18.16" },
  )

  try {
    await hooks.tool?.cycle_control.execute(
      { mode: "quick", operation: "run" },
      { sessionID: "hung-session" },
    )
    await hooks["chat.message"]?.(
      { agent: "Cycle", sessionID: "hung-session" },
      { parts: [{ text: "Add a label to the live probe.", type: "text" }] },
    )
    while (admissionCalls === 0) await Promise.resolve()
    await Promise.resolve()
    const result = await hooks.tool?.cycle_control.execute(
      { operation: "retry", workflowId },
      { abort: new AbortController().signal, sessionID: "hung-session" },
    )
    expect(JSON.parse(result.output)).toMatchObject({ state: "completed", workflowId })
    expect(recoveryStatusCalls).toBeGreaterThan(0)
    expect(startWorkflow).toHaveBeenCalledTimes(1)
  } finally {
    await hooks.dispose?.()
    restoreNative()
    admission.mockRestore()
    startWorkflow.mockRestore()
    control.mockRestore()
    await rm(worktree, { force: true, recursive: true })
  }
})

test("retry leaves a live role session with its background orchestrator", async () => {
  const worktree = await gitWorkspace()
  const workflowId = "018f47d0-a9b2-7c1d-8a77-123456789abc"
  const statuses: Record<string, { type: string }> = {}
  let recoveryCalls = 0
  const control = spyOn(LocalControlPlane.prototype, "control").mockImplementation(
    async (_projectKey, operation) => {
      if (operation === "retry") return { state: "quick_execution", workflowId }
      if (operation === "recovery") {
        recoveryCalls += 1
        throw new Error("live role sessions must not enter retry recovery")
      }
      return { state: "architecture", workflowId }
    },
  )
  const startWorkflow = spyOn(LocalControlPlane.prototype, "startWorkflow").mockResolvedValue({
    mode: "quick",
    requestDigest: "a".repeat(64),
    workflowId,
  })
  const admission = spyOn(LocalControlPlane.prototype, "admission").mockResolvedValue({
    active: 1,
    admitted: true,
    leaseExpiresUnixMillis: Date.now() + 60_000,
    maximumActive: 2,
    reason: null,
    retryAfterMillis: 0,
  })
  const codeIndex = spyOn(LocalControlPlane.prototype, "codeIndex").mockResolvedValue({
    context: { nodes: [], paths: [], scopes: [], truncated: false },
    index: { parsedFiles: 0, reused: false },
  })
  const restoreNative = stubNativeReadBoundary()
  const hooks = await OpenCodeCycle(
    {
      ...supportedInput,
      directory: worktree,
      worktree,
      client: {
        ...supportedInput.client,
        session: {
          ...supportedInput.client.session,
          async create() {
            statuses["architect-session"] = { type: "busy" }
            return { data: { id: "architect-session" } }
          },
          prompt(options: { signal?: AbortSignal }) {
            return new Promise((_resolve, reject) => {
              const signal = options.signal
              if (signal?.aborted) {
                reject(signal.reason)
                return
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
            })
          },
          status: async () => ({ data: statuses }),
        },
      },
    } as never,
    { hostVersion: "1.18.16" },
  )

  try {
    await hooks.tool?.cycle_control.execute(
      { mode: "quick", operation: "run" },
      { sessionID: "live-session" },
    )
    await hooks["chat.message"]?.(
      { agent: "Cycle", sessionID: "live-session" },
      { parts: [{ text: "Add a label to the live probe.", type: "text" }] },
    )
    const startedAt = Date.now()
    while (statuses["architect-session"] === undefined) {
      if (Date.now() - startedAt > 10_000) throw new Error("architect session was not created")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const result = await hooks.tool?.cycle_control.execute(
      { operation: "retry", workflowId },
      { abort: new AbortController().signal, sessionID: "live-session" },
    )
    expect(JSON.parse(result.output)).toMatchObject({ state: "quick_execution", workflowId })
    expect(recoveryCalls).toBe(0)
  } finally {
    await hooks.dispose?.()
    restoreNative()
    codeIndex.mockRestore()
    admission.mockRestore()
    startWorkflow.mockRestore()
    control.mockRestore()
    await rm(worktree, { force: true, recursive: true })
  }
})

test("native Cycle role models are effective after config registration", async () => {
  const restoreNative = stubNativeReadBoundary()
  const hooks = await OpenCodeCycle(supportedInput as never, { hostVersion: "1.18.16" })
  const config = {
    agent: {
      "Cycle Architect": { model: "provider-a/architect" },
      "Cycle Executor": { model: "provider-b/executor", variant: "max" },
      "Cycle Functional Reviewer": { model: "provider-c/functional" },
      "Cycle Security and Architecture Reviewer": { model: "provider-d/security" },
      "Cycle Arbiter": { model: "provider-e/arbiter" },
    },
    command: {},
  }

  try {
    await hooks.config?.(config as never)
    await hooks["chat.message"]?.(
      {
        agent: "Cycle",
        model: { modelID: "deepseek-v4-flash", providerID: "opencode-go" },
        sessionID: "native-model-session",
      },
      { parts: [{ text: "Discuss this change.", type: "text" }] },
    )
    const result = await hooks.tool?.cycle_control.execute(
      { operation: "models" },
      { sessionID: "native-model-session" },
    )

    expect(JSON.parse(result.output)).toEqual({
      activeModel: "opencode-go/deepseek-v4-flash",
      activeVariant: null,
      assignments: {
        architect: "provider-a/architect",
        executor: "provider-b/executor",
        functional_reviewer: "provider-c/functional",
        security_reviewer: "provider-d/security",
        arbiter: "provider-e/arbiter",
      },
      persistence:
        "Native Cycle agent and plugin option assignments persist after restart; runtime overrides do not.",
      reasoning: {},
      variants: { executor: "max" },
    })
  } finally {
    await hooks.dispose?.()
    restoreNative()
  }
})

test("plugin role model options override native Cycle role models", async () => {
  const hooks = await OpenCodeCycle(supportedInput as never, {
    arbiterModel: "plugin/arbiter",
    hostVersion: "1.18.16",
  })
  const config = {
    agent: { "Cycle Arbiter": { model: "native/arbiter", variant: "xhigh" } },
    command: {},
  }

  await hooks.config?.(config as never)
  const result = await hooks.tool?.cycle_control.execute(
    { operation: "models" },
    { sessionID: "session" },
  )

  expect(JSON.parse(result.output)).toMatchObject({
    assignments: { arbiter: "plugin/arbiter" },
    variants: {},
  })
  expect(config.agent["Cycle Arbiter"].model).toBe("native/arbiter")
})

test("model inspection exposes only effective reasoning controls from native agents", async () => {
  const hooks = await OpenCodeCycle(
    {
      ...supportedInput,
      client: {
        ...supportedInput.client,
        app: {
          ...supportedInput.client.app,
          async agents() {
            return {
              data: [
                {
                  name: "Cycle Architect",
                  options: { apiKey: "secret", reasoningEffort: "xhigh" },
                },
                {
                  name: "Cycle Functional Reviewer",
                  options: { thinking: { budgetTokens: 8192, type: "adaptive" } },
                },
                {
                  name: "Cycle Arbiter",
                  options: { reasoningEffort: "high value" },
                  variant: "xhigh",
                },
              ],
            }
          },
        },
      },
    } as never,
    { hostVersion: "1.18.16" },
  )

  const result = await hooks.tool?.cycle_control.execute(
    { operation: "models" },
    { sessionID: "reasoning-session" },
  )
  const parsed = JSON.parse(result.output)

  expect(parsed.reasoning).toEqual({
    architect: { reasoningEffort: "xhigh" },
    arbiter: { variant: "xhigh" },
    functional_reviewer: { thinking: { budgetTokens: 8192, type: "adaptive" } },
  })
  expect(result.output).not.toContain("secret")
})

test("native Cycle role assignments refresh on every configuration hook", async () => {
  const hooks = await OpenCodeCycle(supportedInput as never, { hostVersion: "1.18.16" })
  const config = { agent: { "Cycle Architect": { model: "native/architect-a" } }, command: {} }

  await hooks.config?.(config as never)
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "native-refresh-session" },
      )).output,
    ).assignments,
  ).toEqual({ architect: "native/architect-a" })

  config.agent["Cycle Architect"].model = "native/architect-b"
  await hooks.config?.(config as never)
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "native-refresh-session" },
      )).output,
    ).assignments,
  ).toEqual({ architect: "native/architect-b" })

  delete config.agent["Cycle Architect"].model
  await hooks.config?.(config as never)
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "native-refresh-session" },
      )).output,
    ).assignments,
  ).toEqual({})
})

test("runtime and plugin assignments survive native configuration reloads", async () => {
  const hooks = await OpenCodeCycle(supportedInput as never, {
    architectModel: "plugin/architect",
    hostVersion: "1.18.16",
  })
  const initial = { agent: { "Cycle Architect": { model: "native/architect-a" } }, command: {} }

  await hooks.config?.(initial as never)
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "precedence-session" },
      )).output,
    ).assignments,
  ).toEqual({ architect: "plugin/architect" })

  const nativeReload = { agent: { "Cycle Architect": { model: "native/architect-b" } }, command: {} }
  await hooks.config?.(nativeReload as never)
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "precedence-session" },
      )).output,
    ).assignments,
  ).toEqual({ architect: "plugin/architect" })

  await hooks.tool?.cycle_control.execute(
    { model: "runtime/architect", operation: "models", role: "architect" },
    { sessionID: "precedence-session" },
  )
  const replacement = {
    agent: { "Cycle Architect": { model: "native/architect-c", variant: "max" } },
    command: {},
  }
  await hooks.config?.(replacement as never)

  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "precedence-session" },
      )).output,
    ).assignments,
  ).toEqual({ architect: "runtime/architect" })
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "precedence-session" },
      )).output,
    ).variants,
  ).toEqual({})
})

test("plugin-injected models remain plugin assignments across reused and replacement configs", async () => {
  const hooks = await OpenCodeCycle(supportedInput as never, {
    executorModel: "plugin/executor",
    hostVersion: "1.18.16",
  })
  const reused = { agent: {}, command: {} }

  await hooks.config?.(reused as never)
  expect(reused.agent["Cycle Executor"].model).toBe("plugin/executor")
  await hooks.config?.(reused as never)
  const replacement = { agent: {}, command: {} }
  await hooks.config?.(replacement as never)

  expect(replacement.agent["Cycle Executor"].model).toBe("plugin/executor")
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "plugin-reload-session" },
      )).output,
    ).assignments,
  ).toEqual({ executor: "plugin/executor" })
})

test("malformed native Cycle role model values are ignored", async () => {
  const hooks = await OpenCodeCycle(supportedInput as never, { hostVersion: "1.18.16" })
  const config = {
    agent: {
      "Cycle Architect": { model: ["provider/architect"] },
      "Cycle Executor": { model: "not-a-provider-model" },
      "Cycle Arbiter": { model: "provider/arbiter" },
    },
    command: {},
  }

  await hooks.config?.(config as never)
  const result = await hooks.tool?.cycle_control.execute(
    { operation: "models" },
    { sessionID: "session" },
  )

  expect(JSON.parse(result.output).assignments).toEqual({ arbiter: "provider/arbiter" })
  expect(config.agent["Cycle Architect"].model).toBeUndefined()
  expect(config.agent["Cycle Executor"].model).toBeUndefined()
})

test("direct role consultations use native Cycle role models", async () => {
  const prompts: unknown[] = []
  const input = {
    ...supportedInput,
    client: {
      ...supportedInput.client,
      session: {
        ...supportedInput.client.session,
        async create() {
          return { data: { id: "architect-session" } }
        },
        async prompt(options: unknown) {
          prompts.push(options)
          return { data: { parts: [{ text: "Advice", type: "text" }] } }
        },
      },
    },
  }
  const restoreNative = stubNativeReadBoundary()
  const hooks = await OpenCodeCycle(input as never, { hostVersion: "1.18.16" })
  try {
    await hooks.config?.({
      agent: { "Cycle Architect": { model: "native/architect", variant: "xhigh" } },
      command: {},
    } as never)
    await hooks["chat.message"]?.(
      { agent: "Cycle", sessionID: "native-consult-session" },
      { parts: [{ text: "Assess this proposal.", type: "text" }] },
    )

    await hooks.tool?.cycle_role.execute(
      { operation: "architect_consult" },
      { sessionID: "native-consult-session" },
    )

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      body: {
        agent: "Cycle Architect",
        model: { modelID: "architect", providerID: "native" },
        variant: "xhigh",
      },
    })
  } finally {
    await hooks.dispose?.()
    restoreNative()
  }
})

test("a role without an assignment falls back to the active session model", async () => {
  const prompts: unknown[] = []
  const input = {
    ...supportedInput,
    client: {
      ...supportedInput.client,
      session: {
        ...supportedInput.client.session,
        async create() {
          return { data: { id: "fallback-architect-session" } }
        },
        async prompt(options: unknown) {
          prompts.push(options)
          return { data: { parts: [{ text: "Advice", type: "text" }] } }
        },
      },
    },
  }
  const restoreNative = stubNativeReadBoundary()
  const hooks = await OpenCodeCycle(input as never, { hostVersion: "1.18.16" })
  try {
    await hooks.config?.({ agent: {}, command: {} } as never)
    await hooks["chat.message"]?.(
      {
        agent: "Cycle",
        model: { modelID: "active", providerID: "session" },
        sessionID: "fallback-model-session",
        variant: "high",
      },
      { parts: [{ text: "Assess this proposal.", type: "text" }] },
    )

    await hooks.tool?.cycle_role.execute(
      { operation: "architect_consult" },
      { sessionID: "fallback-model-session" },
    )

    expect(prompts[0]).toMatchObject({
      body: {
        agent: "Cycle Architect",
        model: { modelID: "active", providerID: "session" },
        variant: "high",
      },
    })
  } finally {
    await hooks.dispose?.()
    restoreNative()
  }
})

test("records successful native registration for Desktop certification", async () => {
  const logs: unknown[] = []
  const dataDirectory = await mkdtemp(join(tmpdir(), "opencode-cycle-activation-"))
  const input = {
    ...supportedInput,
    client: {
      ...supportedInput.client,
      app: {
        ...supportedInput.client.app,
        log: async (entry: unknown) => {
          logs.push(entry)
          return {}
        },
      },
    },
  }
  try {
    const hooks = await OpenCodeCycle(input as never, { dataDirectory, hostVersion: "1.18.16" })
    expect(await readFile(join(dataDirectory, "desktop-activation.log"), "utf8")).toBe(
      "Cycle for OpenCode activated\n",
    )

    await hooks.config?.({ agent: {}, command: {} } as never)

    expect(logs).toEqual([
      {
        body: {
          level: "info",
          message: "Cycle for OpenCode activated",
          extra: { host_certified: true, host_version: "1.18.16", product_version: "1.0.0" },
          service: "opencode-cycle",
        },
      },
    ])
    expect(await readFile(join(dataDirectory, "desktop-activation.log"), "utf8")).toBe(
      "Cycle for OpenCode activated\n",
    )
  } finally {
    await rm(dataDirectory, { force: true, recursive: true })
  }
})

test("capability failure returns inert hooks without throwing", async () => {
  const hooks = await OpenCodeCycle({ client: {} } as never, { hostVersion: "1.18.16" })
  expect(Object.keys(hooks)).toEqual(["config"])
  const config = { command: {} }
  await hooks.config?.(config as never)
  expect(config.command.cycle?.template).toContain("did not start")
  expect(config.command.cycle?.template).toContain("1.18.16")
})

test("safe mode logs one controlled warning for unreadable or other-major host versions", async () => {
  for (const options of [{ hostVersion: "1.18.19.untrusted" }, { hostVersion: "2.0.0" }]) {
    const logs: unknown[] = []
    const input = {
      ...supportedInput,
      client: {
        ...supportedInput.client,
        app: {
          agents() {},
          async log(entry: unknown) {
            logs.push(entry)
            return {}
          },
        },
      },
    }

    const hooks = await OpenCodeCycle(input as never, options)
    expect(Object.keys(hooks)).toEqual(["config"])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toEqual({
      body: {
        level: "warn",
        message: "Cycle for OpenCode entered safe mode",
        extra: {
          product_version: "1.0.0",
          reasons:
            options.hostVersion === "2.0.0"
              ? "Unsupported OpenCode host version"
              : "OpenCode host version is unreadable",
        },
        service: "opencode-cycle",
      },
    })
  }
})

test("compatible uncertified Desktop updates activate and surface a host notice", async () => {
  const logs: unknown[] = []
  const input = {
    ...supportedInput,
    client: {
      ...supportedInput.client,
      app: {
        ...supportedInput.client.app,
        async log(entry: unknown) {
          logs.push(entry)
          return {}
        },
      },
    },
  }
  const hooks = await OpenCodeCycle(input as never, { hostVersion: "1.18.19" })
  expect(Object.keys(hooks)).toContain("tool")
  const config = { command: {}, agent: {} }
  await hooks.config?.(config as never)
  expect(config.command.cycle?.description).toContain("1.18.19")
  expect(config.command.cycle?.template).toContain("Host notice")
  expect(logs.some((entry) => JSON.stringify(entry).includes("Cycle for OpenCode activated"))).toBeTrue()
})

test("safe mode diagnostics never include health response content", async () => {
  const secret = "body-secret-that-must-not-be-logged"
  const logs: unknown[] = []
  const server = Bun.serve({
    fetch() {
      return Response.json({ healthy: true, metadata: secret, version: `${secret}.version` })
    },
    port: 0,
  })
  try {
    const hooks = await OpenCodeCycle({
      ...supportedInput,
      client: {
        ...supportedInput.client,
        app: {
          agents() {},
          async log(entry: unknown) {
            logs.push(entry)
            return {}
          },
        },
      },
      serverUrl: new URL(`http://127.0.0.1:${server.port}`),
    } as never)
    expect(Object.keys(hooks)).toEqual(["config"])
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(logs)).not.toContain(secret)
  } finally {
    server.stop(true)
  }
})

test("safe mode remains inert when logging is missing or fails", async () => {
  const missingLogger = {
    ...supportedInput,
    client: { ...supportedInput.client, app: { agents() {} } },
  }
  const missingHooks = await OpenCodeCycle(missingLogger as never, { hostVersion: "2.0.0" })
  expect(Object.keys(missingHooks)).toEqual(["config"])

  const failingLogger = {
    ...supportedInput,
    client: {
      ...supportedInput.client,
      app: {
        agents() {},
        log() {
          throw new Error("logging unavailable")
        },
      },
    },
  }
  const failingHooks = await OpenCodeCycle(failingLogger as never, { hostVersion: "2.0.0" })
  expect(Object.keys(failingHooks)).toEqual(["config"])
})

test("automatic compatibility probing performs only the read-only health request", async () => {
  let calls = 0
  const operation = () => {
    calls += 1
  }
  const server = Bun.serve({
    fetch(request) {
      calls += 1
      expect(new URL(request.url).pathname).toBe("/global/health")
      expect(request.method).toBe("GET")
      return Response.json({ healthy: true, version: "1.18.18" })
    },
    port: 0,
  })
  const input = {
    client: {
      app: { agents: operation, log: operation },
      config: { providers: operation },
      session: {
        abort: operation,
        children: operation,
        create: operation,
        prompt: operation,
        promptAsync: operation,
      },
    },
    serverUrl: new URL(`http://127.0.0.1:${server.port}`),
  }
  try {
    const hooks = await OpenCodeCycle(input as never)
    expect(hooks.config).toBeFunction()
    expect(calls).toBe(1)
  } finally {
    server.stop(true)
  }
})

test("health without a certified version still activates when capabilities exist", async () => {
  for (const response of [
    () => Response.json({ healthy: true }),
    () => Response.json({ healthy: true, version: "1.18.19" }),
    () => new Response("unavailable", { status: 503 }),
  ]) {
    const server = Bun.serve({ fetch: response, port: 0 })
    try {
      const hooks = await OpenCodeCycle({
        ...supportedInput,
        serverUrl: new URL(`http://127.0.0.1:${server.port}`),
      } as never)
      expect(Object.keys(hooks)).toContain("tool")
    } finally {
      server.stop(true)
    }
  }
})

test("malformed host version from health leaves the plugin inert", async () => {
  const server = Bun.serve({
    fetch() {
      return Response.json({ healthy: true, version: "1.18.19.untrusted" })
    },
    port: 0,
  })
  try {
    const hooks = await OpenCodeCycle({
      ...supportedInput,
      serverUrl: new URL(`http://127.0.0.1:${server.port}`),
    } as never)
    expect(Object.keys(hooks)).toEqual(["config"])
  } finally {
    server.stop(true)
  }
})

test("malformed configuration leaves all fields unchanged and reports safe mode", async () => {
  let logs = 0
  const input = {
    client: {
      ...supportedInput.client,
      app: {
        ...supportedInput.client.app,
        log: async () => {
          logs += 1
          return {}
        },
      },
    },
  }
  const hooks = await OpenCodeCycle(input as never, { hostVersion: "1.18.16" })
  const config = { agent: { plan: { mode: "primary" } }, command: [] }
  const before = structuredClone(config)
  await hooks.config?.(config as never)
  expect(config).toEqual(before)
  expect(logs).toBe(1)
})

test("failed configuration registration preserves the last valid native role assignments", async () => {
  const logs: unknown[] = []
  const input = {
    ...supportedInput,
    client: {
      ...supportedInput.client,
      app: {
        ...supportedInput.client.app,
        async log(entry: unknown) {
          logs.push(entry)
          return {}
        },
      },
    },
  }
  const hooks = await OpenCodeCycle(input as never, { hostVersion: "1.18.16" })
  await hooks.config?.({
    agent: { "Cycle Architect": { model: "native/architect-a" } },
    command: {},
  } as never)
  const invalid = {
    agent: { "Cycle Architect": { model: "native/architect-b" } },
    command: [],
  }
  const before = structuredClone(invalid)

  await hooks.config?.(invalid as never)

  expect(invalid).toEqual(before)
  expect(logs).toHaveLength(2)
  expect(logs[1]).toMatchObject({ body: { level: "error", message: "Cycle for OpenCode entered safe mode" } })
  expect(
    JSON.parse(
      (await hooks.tool?.cycle_control.execute(
        { operation: "models" },
        { sessionID: "atomic-config-session" },
      )).output,
    ).assignments,
  ).toEqual({ architect: "native/architect-a" })
})

test("native dispatch explains sensitive command confirmation without surfacing a host error", async () => {
  const restoreNative = stubNativeReadBoundary()
  const hooks = await OpenCodeCycle(supportedInput as never, { hostVersion: "1.18.16" })
  await hooks.config?.({ agent: {}, command: {} } as never)
  const sessionID = "command-guidance-session"
  const output = {
    parts: [
      {
        id: "part",
        messageID: "message",
        sessionID,
        text: "Execute the native Cycle for OpenCode command with these arguments: cancel",
        type: "text" as const,
      },
    ],
  }

  await expect(
    hooks["command.execute.before"]?.(
      { arguments: "cancel", command: "cycle", sessionID },
      output,
    ),
  ).resolves.toBeUndefined()
  expect(output.parts).toMatchObject([
    {
      synthetic: true,
      text: "Cycle for OpenCode did not run /cycle cancel. This command requires explicit --confirm after user approval. Explain that requirement and do not call tools.",
      type: "text",
    },
  ])
  try {
    await expect(
      hooks["chat.message"]?.(
        { agent: "Cycle", sessionID },
        output as never,
      ),
    ).resolves.toBeUndefined()
  } finally {
    await hooks.dispose?.()
    restoreNative()
  }
})

test("native dispatch explains invalid commands without surfacing a host error", async () => {
  const hooks = await OpenCodeCycle(supportedInput as never, { hostVersion: "1.18.16" })
  const output = {
    parts: [
      {
        id: "part",
        messageID: "message",
        sessionID: "session",
        text: "Execute the native Cycle for OpenCode command with these arguments: run impossible",
        type: "text" as const,
      },
    ],
  }

  await expect(
    hooks["command.execute.before"]?.(
      { arguments: "run impossible", command: "cycle", sessionID: "session" },
      output,
    ),
  ).resolves.toBeUndefined()
  expect(output.parts).toMatchObject([
    {
      synthetic: true,
      text: "Cycle for OpenCode did not run /cycle run. The mode must be auto, quick or full. Explain the valid modes and do not call tools.",
      type: "text",
    },
  ])
})
