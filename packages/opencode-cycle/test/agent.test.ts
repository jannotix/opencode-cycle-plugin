import { describe, expect, test } from "bun:test"

import {
  ROLE_AGENT_NAMES,
  CYCLE_AGENT_NAME,
  registerCycleAgent,
  roleModelsFromNativeConfig,
  roleVariantsFromNativeConfig,
} from "../src/agent.js"

describe("Cycle agent registration", () => {
  test("adds a primary agent without changing existing agents or settings", () => {
    const config = {
      agent: {
        plan: { mode: "primary" as const, temperature: 0.1 },
        build: { mode: "primary" as const },
        custom: { description: "Keep me" },
      },
      model: "provider/model",
      theme: "native",
    }
    const preserved = structuredClone(config)

    registerCycleAgent(config)

    expect(config.agent.Cycle?.mode).toBe("primary")
    expect(config.agent["Cycle Executor"]?.mode).toBe("subagent")
    expect(config.agent.WorkFlow).toBeUndefined()
    expect(config.agent.plan).toEqual(preserved.agent.plan)
    expect(config.agent.build).toEqual(preserved.agent.build)
    expect(config.agent.custom).toEqual(preserved.agent.custom)
    expect(config.model).toBe(preserved.model)
    expect(config.theme).toBe(preserved.theme)
  })

  test("is idempotent and preserves explicit user model settings", () => {
    const config = {
      agent: {
        Cycle: { model: "user/reviewer", temperature: 0.2 },
      },
    }

    registerCycleAgent(config)
    const once = structuredClone(config)
    registerCycleAgent(config)

    expect(config).toEqual(once)
    expect(config.agent.Cycle.model).toBe("user/reviewer")
    expect(config.agent.Cycle.temperature).toBe(0.2)
  })

  test("rejects malformed agent configuration without mutating input", () => {
    const config = { agent: [] } as unknown
    const before = structuredClone(config)

    expect(() => registerCycleAgent(config)).toThrow("agent configuration")
    expect(config).toEqual(before)
  })

  test("registers five isolated role agents with model inheritance and read-only boundaries", () => {
    const config = { model: "provider/active", permission: { edit: "allow" as const } }

    registerCycleAgent(config, {
      models: { arbiter: "independent/arbiter" },
      permissionPreset: "balanced",
    })

    const agents = config.agent as Record<string, Record<string, unknown>>
    expect(Object.values(ROLE_AGENT_NAMES).every((name) => agents[name]?.mode === "subagent")).toBe(
      true,
    )
    expect(Object.values(ROLE_AGENT_NAMES).every((name) => agents[name]?.hidden === true)).toBe(true)
    expect(agents[ROLE_AGENT_NAMES.arbiter]?.model).toBe("independent/arbiter")
    expect(agents[ROLE_AGENT_NAMES.architect]?.model).toBeUndefined()
    expect(agents[ROLE_AGENT_NAMES.executor]?.permission).toEqual({
      doom_loop: "ask",
      external_directory: "deny",
      task: "deny",
    })
    expect(agents[ROLE_AGENT_NAMES.functional_reviewer]?.permission).toEqual({
      doom_loop: "ask",
      edit: "deny",
      external_directory: "deny",
      task: "deny",
    })
  })

  test("host-expanded agent defaults cannot weaken immutable role boundaries", () => {
    const config = {
      agent: {
        [CYCLE_AGENT_NAME]: {
          permission: { edit: "allow" },
          prompt: "Host default",
          tools: { apply_patch: true, edit: true, task: true, write: true },
        },
        [ROLE_AGENT_NAMES.architect]: {
          model: "configured/architect",
          permission: { edit: "allow", external_directory: "allow" },
          prompt: "Host default",
          reasoningEffort: "xhigh",
          tools: { apply_patch: true, edit: true, task: true, write: true },
        },
      },
    }

    registerCycleAgent(config)

    const workflow = config.agent[CYCLE_AGENT_NAME]
    const architect = config.agent[ROLE_AGENT_NAMES.architect]
    expect(workflow.permission.edit).toBe("deny")
    expect(workflow.tools.bash).toBeFalse()
    expect(workflow.tools.task).toBeFalse()
    expect(workflow.prompt).toContain("native entrypoint")
    expect(workflow.prompt).toContain("Do not poll")
    expect(workflow.prompt).toContain("Do not call run again")
    expect(workflow.prompt).toContain("report the returned workflow state verbatim")
    expect(architect.model).toBe("configured/architect")
    expect(architect.reasoningEffort).toBe("xhigh")
    expect(architect.permission.edit).toBe("deny")
    expect(architect.permission.external_directory).toBe("deny")
    expect(architect.tools).toMatchObject({
      apply_patch: false,
      bash: false,
      edit: false,
      task: false,
      write: false,
    })
    expect(architect.prompt).toContain("isolated Cycle for OpenCode architect")
  })

  test("extracts only bounded native variants attached to valid role models", () => {
    const config = {
      agent: {
        [ROLE_AGENT_NAMES.architect]: { model: "provider/architect", variant: "xhigh" },
        [ROLE_AGENT_NAMES.executor]: { model: "provider/executor", variant: "bad variant" },
        [ROLE_AGENT_NAMES.arbiter]: { variant: "max" },
      },
    }
    const models = roleModelsFromNativeConfig(config)

    expect(roleVariantsFromNativeConfig(config, models)).toEqual({ architect: "xhigh" })
    expect(config.agent[ROLE_AGENT_NAMES.executor].variant).toBeUndefined()
    expect(config.agent[ROLE_AGENT_NAMES.arbiter].variant).toBeUndefined()
  })
})
