import { join } from "node:path"

import type { Config, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"

import {
  permissionPresetFromOptions,
  ROLE_AGENT_NAMES,
  registerCycleAgent,
  removeInjectedRoleModels,
  roleModelsFromNativeConfig,
  roleModelsFromOptions,
  roleVariantsFromNativeConfig,
  type RoleVariants,
} from "./agent.js"
import { digest, observation } from "./audit-events.js"
import { BrowserEvidenceRegistry } from "./browser/browser-evidence.js"
import { BrowserManager } from "./browser/browser-manager.js"
import { ManagedBrowserSessionFactory } from "./browser/managed-browser-session.js"
import { assertBrowserCommandRole, cycleBrowserTool } from "./browser/browser-tool.js"
import {
  CERTIFIED_HOST_VERSIONS,
  hostCommandNotice,
  negotiateCapabilities,
} from "./capabilities.js"
import { parseCycleCommand, registerCycleCommand } from "./commands.js"
import {
  certificationBindingFromOptions,
  desktopCertificationProcessToken,
  writeDesktopDaemonMarker,
  writeDesktopActivationMarker,
} from "./certification.js"
import {
  LocalControlPlane,
  resolveDataDirectory,
  type AdmissionReceipt,
  type CodeIndexReceipt,
} from "./control-plane.js"
import { inspectProviders, setupReport } from "./commands/setup.js"
import { captureWorkflowRequest } from "./commands/run.js"
import { resolveHostVersion } from "./host-version.js"
import { runFullWorkflow } from "./orchestration/full-workflow.js"
import { recoverWorkflowRetry } from "./orchestration/retry-recovery.js"
import { RoleConsultations } from "./orchestration/role-consultation.js"
import type { WorkflowRole } from "./permissions.js"
import {
  activeWorkflowForSession,
  RequestRouter,
  type RoutedWorkflowRequest,
} from "./request-router.js"
import { assertGitRepository, inspectGitRepository } from "./git-repository.js"
import { ROLE_PROMPT_LIMITS } from "./orchestration/session-prompt.js"
import { RoleSessionPolicy } from "./role-session-policy.js"
import { SingleFlight } from "./single-flight.js"
import { CYCLE_AGENT_NAME, CYCLE_TOOL_NAMES, PRODUCT_NAME, PRODUCT_SERVICE } from "./product.js"
import { cycleRoleTool } from "./cycle-role-tool.js"
import { cycleControlTool } from "./cycle-tool.js"

const PRODUCT_VERSION = "1.0.0"

function optionString(options: PluginOptions | undefined, key: string): string | undefined {
  const value = options?.[key]
  return typeof value === "string" ? value : undefined
}

function optionBoolean(options: PluginOptions | undefined, key: string, fallback: boolean): boolean {
  const value = options?.[key]
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

function optionInteger(options: PluginOptions | undefined, key: string, fallback: number): number {
  const value = options?.[key]
  if (value === undefined) return fallback
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return value as number
}

function optionStrings(options: PluginOptions | undefined, key: string): readonly string[] {
  const value = options?.[key]
  if (value === undefined) return []
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean)
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value
  throw new Error(`${key} must be a string array or comma-separated string`)
}

function replaceCommandGuidance(parts: Part[], text: string): void {
  const textPart = parts.find((part) => part.type === "text")
  if (textPart === undefined) return
  textPart.text = text
  textPart.synthetic = true
  parts.splice(0, parts.length, textPart)
}

async function logSetupFailure(input: PluginInput, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await input.client.app
    .log({
      body: {
        level: "error",
        message: `${PRODUCT_NAME} entered safe mode`,
        extra: { reason: message },
        service: PRODUCT_SERVICE,
      },
    })
    .catch(() => undefined)
}

async function logSafeMode(input: PluginInput, reasons: readonly string[]): Promise<void> {
  const client = (input as { readonly client?: unknown }).client
  if (typeof client !== "object" || client === null) return
  const app = (client as Record<string, unknown>).app
  if (typeof app !== "object" || app === null) return
  const log = (app as Record<string, unknown>).log
  if (typeof log !== "function") return
  try {
    await log.call(app, {
      body: {
        level: "warn",
        message: `${PRODUCT_NAME} entered safe mode`,
        extra: { product_version: PRODUCT_VERSION, reasons: reasons.join("; ") },
        service: PRODUCT_SERVICE,
      },
    })
  } catch {}
}

async function logWorkflowFailure(input: PluginInput, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await input.client.app
    .log({
      body: {
        level: "error",
        message: `${PRODUCT_NAME} stopped the active workflow`,
        extra: { reason: message },
        service: PRODUCT_SERVICE,
      },
    })
    .catch(() => undefined)
}

const OpenCodeCycle: Plugin = async (input, options) => {
  const hostVersionOverride = optionString(options, "hostVersion")
  const hostVersion = await resolveHostVersion(input.serverUrl, {
    ...(hostVersionOverride === undefined ? {} : { override: hostVersionOverride }),
  })
  const report = negotiateCapabilities(input.client, hostVersion)
  if (report.safeMode) {
    await logSafeMode(input, report.reasons)
    const reasons = report.reasons.join("; ")
    const certified = CERTIFIED_HOST_VERSIONS.join(", ")
    return {
      async config(config: Config) {
        registerCycleCommand(config)
        const cycleCommand = config.command?.cycle as { agent?: string; description?: string; template?: string } | undefined
        if (cycleCommand !== undefined) {
          cycleCommand.agent = "plan"
          cycleCommand.description = "Cycle for OpenCode is in safe mode"
          cycleCommand.template =
            `Cycle for OpenCode did not start. ${reasons}. Certified OpenCode Desktop versions: ${certified}. Do not call tools.`
        }
      },
    }
  }
  const binaryPath = optionString(options, "binaryPath")
  const dataDirectory = optionString(options, "dataDirectory")
  const pluginOptions = options ?? {}
  let pluginRoleModels: ReturnType<typeof roleModelsFromOptions>
  let permissionPreset: ReturnType<typeof permissionPresetFromOptions>
  try {
    pluginRoleModels = roleModelsFromOptions(pluginOptions)
    permissionPreset = permissionPresetFromOptions(pluginOptions)
  } catch (error) {
    await logSetupFailure(input, error)
    return {}
  }
  const certificationBinding = certificationBindingFromOptions(pluginOptions, process.env)
  const controlPlane = new LocalControlPlane({
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    ...(certificationBinding === undefined
      ? {}
      : {
          onProcessSpawn: (identity: import("./client.js").OwnedProcessIdentity) =>
            writeDesktopDaemonMarker(certificationBinding, identity).then(() => undefined),
          processOwnerToken: desktopCertificationProcessToken(certificationBinding),
          stopOwnedProcessOnDispose: true,
        }),
  })
  if (certificationBinding !== undefined) {
    try {
      const health = await controlPlane.health()
      await writeDesktopActivationMarker(
        certificationBinding,
        health,
        controlPlane.ownedProcessIdentity(),
      )
    } catch (error) {
      await controlPlane.dispose()
      throw error
    }
  }
  const projectKey = input.project?.id ?? input.directory ?? "unknown-project"
  const workflowSessions = new Set<string>()
  const workflows = new Map<string, string>()
  const roleSessions = new Map<string, WorkflowRole>()
  const roleSessionPolicy = new RoleSessionPolicy(
    dataDirectory ?? resolveDataDirectory(process.platform, process.env),
  )
  const activeRuns = new Set<Promise<void>>()
  const activeWorkflowIds = new Set<string>()
  const workflowOrchestrators = new Map<
    string,
    { readonly abort: AbortController; readonly run: Promise<void> }
  >()
  const recoveryFlights = new SingleFlight<unknown>()
  const shutdown = new AbortController()
  const activeModels = new Map<string, string>()
  const activeVariants = new Map<string, string>()
  let nativeRoleModels: ReturnType<typeof roleModelsFromOptions> = {}
  let nativeRoleVariants: RoleVariants = {}
  let runtimeRoleModels: ReturnType<typeof roleModelsFromOptions> = {}
  const injectedRoleModels = new WeakMap<object, ReturnType<typeof roleModelsFromOptions>>()
  const requestRouter = new RequestRouter()
  let browserManager: BrowserManager
  let browserEvidence: BrowserEvidenceRegistry
  try {
    const browserArtifactDirectory = join(
      dataDirectory ?? resolveDataDirectory(process.platform, process.env),
      "browser",
    )
    const browserFactory = new ManagedBrowserSessionFactory({
      ...(optionString(options, "browserExecutable") === undefined
        ? {}
        : { browserExecutable: optionString(options, "browserExecutable") as string }),
      headless: optionBoolean(options, "browserHeadless", true),
      projectDirectory: input.worktree,
    })
    browserManager = new BrowserManager({
      allowedOrigins: optionStrings(options, "browserAllowedOrigins"),
      artifactDirectory: browserArtifactDirectory,
      create: (browserInput) => browserFactory.create(browserInput),
      maxSessions: optionInteger(options, "browserMaxSessions", 2),
    })
    browserEvidence = new BrowserEvidenceRegistry(browserArtifactDirectory)
  } catch (error) {
    await logSetupFailure(input, error)
    return {}
  }

  function effectiveRoleModels(
    nativeModels: ReturnType<typeof roleModelsFromOptions> = nativeRoleModels,
  ) {
    return { ...nativeModels, ...pluginRoleModels, ...runtimeRoleModels }
  }

  function effectiveRoleVariants(
    nativeModels: ReturnType<typeof roleModelsFromOptions> = nativeRoleModels,
    nativeVariants: RoleVariants = nativeRoleVariants,
  ): RoleVariants {
    const variants: Partial<Record<WorkflowRole, string>> = {}
    for (const role of Object.keys(ROLE_AGENT_NAMES) as WorkflowRole[]) {
      if (
        nativeModels[role] !== undefined &&
        pluginRoleModels[role] === undefined &&
        runtimeRoleModels[role] === undefined &&
        nativeVariants[role] !== undefined
      ) {
        variants[role] = nativeVariants[role]
      }
    }
    return variants
  }

  function injectedModelsForRegistration(nativeModels: ReturnType<typeof roleModelsFromOptions>) {
    const effective = effectiveRoleModels(nativeModels)
    const injected: Partial<Record<WorkflowRole, string>> = {}
    for (const role of Object.keys(ROLE_AGENT_NAMES) as WorkflowRole[]) {
      if (nativeModels[role] === undefined && effective[role] !== undefined) {
        injected[role] = effective[role]
      }
    }
    return injected
  }

  async function workflowHasBusyRoleSessions(workflowId: string): Promise<boolean> {
    if (typeof input.client.session.status !== "function") return false
    const response = await input.client.session
      .status({ query: { directory: input.directory } })
      .catch(() => undefined)
    const statuses = response?.data
    if (statuses === undefined || typeof statuses !== "object") return false
    for (const [sessionId, status] of Object.entries(
      statuses as Record<string, { type?: string }>,
    )) {
      if (workflows.get(sessionId) !== workflowId) continue
      if (!roleSessions.has(sessionId)) continue
      if (status?.type === "busy" || status?.type === "retry") return true
    }
    return false
  }

  async function launchWorkflow(
    sessionId: string,
    routed: RoutedWorkflowRequest,
    callerSignal?: AbortSignal,
  ) {
    const runAbort = new AbortController()
    const runSignal = combineSignals(shutdown.signal, callerSignal, runAbort.signal)
    await assertGitRepository(input.worktree)
    const started = await controlPlane.startWorkflow({
      attachmentHashes: routed.captured.attachmentHashes,
      originalRequest: routed.captured.originalRequest,
      preference: routed.preference,
      projectKey,
    })
    workflows.set(sessionId, started.workflowId)
    activeWorkflowIds.add(started.workflowId)
    const run = runAdmittedWorkflow(
      controlPlane,
      {
        projectKey,
        signal: runSignal,
        sourceDirectory: input.worktree,
        workflowId: started.workflowId,
      },
      (codeContext) =>
        runFullWorkflow(input.client, controlPlane, {
          activeModel: activeModels.get(sessionId) ?? null,
          activeVariant: activeVariants.get(sessionId) ?? null,
          browserAttestations: (sessionIds, candidateDigest) =>
            browserEvidence.attest(sessionIds, candidateDigest),
          codeContext,
          mode: started.mode,
          models: effectiveRoleModels(),
          originalRequest: routed.captured.originalRequest,
          parentSessionId: sessionId,
          projectKey,
          registerSession(roleSessionId, role) {
            workflowSessions.add(roleSessionId)
            workflows.set(roleSessionId, started.workflowId)
            roleSessions.set(roleSessionId, role)
            roleSessionPolicy.authorize(roleSessionId, role)
          },
          requestDigest: started.requestDigest,
          signal: runSignal,
          sourceDirectory: input.worktree,
          workflowId: started.workflowId,
          variants: effectiveRoleVariants(),
        }),
    )
      .then(() => undefined)
      .catch((error: unknown) => logWorkflowFailure(input, error))
      .finally(async () => {
        const browserSessions = [...roleSessions.keys()].filter(
          (roleSessionId) => workflows.get(roleSessionId) === started.workflowId,
        )
        await Promise.allSettled(
          browserSessions.map((roleSessionId) =>
            browserManager.execute(roleSessionId, { operation: "close" }, async () => {}),
          ),
        )
        for (const roleSessionId of browserSessions) {
          browserEvidence.forget(roleSessionId)
          roleSessions.delete(roleSessionId)
          workflowSessions.delete(roleSessionId)
          workflows.delete(roleSessionId)
          roleSessionPolicy.revoke(roleSessionId)
        }
        activeRuns.delete(run)
        if (workflowOrchestrators.get(started.workflowId)?.run === run) {
          workflowOrchestrators.delete(started.workflowId)
          activeWorkflowIds.delete(started.workflowId)
        }
      })
    workflowOrchestrators.set(started.workflowId, { abort: runAbort, run })
    activeRuns.add(run)
    return started
  }

  const setupInspector = {
    async inspect(sessionId: string) {
      const response = await input.client.config.providers({ query: { directory: input.directory } })
      if (response.data === undefined) throw new Error("OpenCode provider inventory is unavailable")
      return setupReport(
        inspectProviders(response.data),
        activeModels.get(sessionId) ?? null,
        activeVariants.get(sessionId) ?? null,
        effectiveRoleModels(),
        effectiveRoleVariants(),
      )
    },
    inspectLimits() {
      return {
        adaptiveResources: true,
        maximumRepairCycles: 5,
        recoveryAdmissionPerTick: 1,
        rolePrompt: ROLE_PROMPT_LIMITS,
        internalFeedback: {
          liveWorkflows: activeWorkflowIds.size,
          maximumRepairCycles: 5,
          recoveryAdmissionPerTick: 1,
          visibility: "internal",
        },
      }
    },
    inspectHost() {
      return report.host
    },
    inspectGit() {
      return inspectGitRepository(input.worktree)
    },
    async inspectModels(sessionId: string, role?: WorkflowRole, model?: string) {
      if ((role === undefined) !== (model === undefined)) {
        throw new Error("Model assignment requires both role and provider/model")
      }
      if (role !== undefined && model !== undefined) {
        if (!/^\S+\/\S+$/u.test(model)) throw new Error("Role model must use provider/model")
        runtimeRoleModels = { ...runtimeRoleModels, [role]: model }
      }
      const response = await Promise.resolve(
        input.client.app.agents({ query: { directory: input.directory } }),
      ).catch(() => undefined)
      return {
        activeModel: activeModels.get(sessionId) ?? null,
        activeVariant: activeVariants.get(sessionId) ?? null,
        assignments: effectiveRoleModels(),
        persistence:
          "Native Cycle agent and plugin option assignments persist after restart; runtime overrides do not.",
        reasoning: inspectRoleReasoning(response?.data),
        variants: effectiveRoleVariants(),
      }
    },
    inspectPermissions() {
      return {
        immutableReadOnlyRoles: ["architect", "functional_reviewer", "security_reviewer", "arbiter"],
        preset: permissionPreset,
        source: "OpenCode native configuration",
      }
    },
    pendingRequest(sessionId: string) {
      return requestRouter.pending(sessionId)?.originalRequest
    },
    async recoverRetry(sessionId: string, result: unknown, callerSignal: AbortSignal) {
      const workflowId =
        typeof result === "object" && result !== null && !Array.isArray(result)
          ? (result as Record<string, unknown>).workflowId
          : undefined
      if (typeof workflowId !== "string") {
        return recoverWorkflowRetry(input.client, controlPlane, {
          active: false,
          activeModel: activeModels.get(sessionId) ?? null,
          activeVariant: activeVariants.get(sessionId) ?? null,
          browserAttestations: (sessionIds, candidateDigest) =>
            browserEvidence.attest(sessionIds, candidateDigest),
          models: effectiveRoleModels(),
          parentSessionId: sessionId,
          projectDirectory: input.worktree,
          projectKey,
          registerSession() {},
          result,
          signal: combineSignals(shutdown.signal, callerSignal),
          variants: effectiveRoleVariants(),
        })
      }
      const previousWorkflowId = workflows.get(sessionId)
      if (
        previousWorkflowId !== undefined &&
        previousWorkflowId !== workflowId &&
        activeWorkflowIds.has(previousWorkflowId)
      ) {
        throw new Error("Cycle session already owns another active workflow")
      }
      const restoreParentMapping = previousWorkflowId !== workflowId
      workflows.set(sessionId, workflowId)
      const recovery = recoveryFlights.run(workflowId, async () => {
        if (await workflowHasBusyRoleSessions(workflowId)) return result
        const previous = workflowOrchestrators.get(workflowId)
        if (previous !== undefined) {
          previous.abort.abort()
          await Promise.race([previous.run, delay(5_000)])
        }
        activeWorkflowIds.delete(workflowId)
        activeWorkflowIds.add(workflowId)
        const runAbort = new AbortController()
        const signal = combineSignals(shutdown.signal, callerSignal, runAbort.signal)
        let settleRun = () => {}
        const run = new Promise<void>((resolve) => {
          settleRun = resolve
        })
        workflowOrchestrators.set(workflowId, { abort: runAbort, run })
        const recoveredSessions: string[] = []
        let failed = true
        try {
          const recovered = await recoverWorkflowRetry(input.client, controlPlane, {
            active: false,
            activeModel: activeModels.get(sessionId) ?? null,
            activeVariant: activeVariants.get(sessionId) ?? null,
            browserAttestations: (sessionIds, candidateDigest) =>
              browserEvidence.attest(sessionIds, candidateDigest),
            models: effectiveRoleModels(),
            parentSessionId: sessionId,
            projectDirectory: input.worktree,
            projectKey,
            registerSession(roleSessionId, role) {
              recoveredSessions.push(roleSessionId)
              workflowSessions.add(roleSessionId)
              workflows.set(roleSessionId, workflowId)
              roleSessions.set(roleSessionId, role)
              roleSessionPolicy.authorize(roleSessionId, role)
            },
            result,
            resumeEarlyStage: (context) =>
              runAdmittedWorkflow(
                controlPlane,
                {
                  projectKey,
                  signal,
                  sourceDirectory: input.worktree,
                  workflowId,
                },
                (codeContext) =>
                  runFullWorkflow(input.client, controlPlane, {
                    activeModel: activeModels.get(sessionId) ?? null,
                    activeVariant: activeVariants.get(sessionId) ?? null,
                    browserAttestations: (sessionIds, candidateDigest) =>
                      browserEvidence.attest(sessionIds, candidateDigest),
                    codeContext,
                    ...(context.plan === undefined ? {} : { initialPlan: context.plan }),
                    ...(context.baseRevision === undefined
                      ? {}
                      : {
                          initialWorktree: {
                            baseRevision: context.baseRevision,
                            path: context.worktreePath,
                          },
                        }),
                    mode: context.mode,
                    models: effectiveRoleModels(),
                    originalRequest: context.originalRequest,
                    parentSessionId: sessionId,
                    projectKey,
                    registerSession(roleSessionId, role) {
                      recoveredSessions.push(roleSessionId)
                      workflowSessions.add(roleSessionId)
                      workflows.set(roleSessionId, workflowId)
                      roleSessions.set(roleSessionId, role)
                      roleSessionPolicy.authorize(roleSessionId, role)
                    },
                    requestDigest: context.requestDigest,
                    ...(context.repairFeedback === undefined
                      ? {}
                      : { repairFeedback: context.repairFeedback }),
                    signal,
                    sourceDirectory: input.worktree,
                    variants: effectiveRoleVariants(),
                    workflowId,
                  }),
              ),
            signal,
            variants: effectiveRoleVariants(),
          })
          failed = false
          return recovered
        } finally {
          settleRun()
          if (workflowOrchestrators.get(workflowId)?.abort === runAbort) {
            workflowOrchestrators.delete(workflowId)
          }
          if (failed || signal.aborted) {
            await Promise.allSettled(
              recoveredSessions.map((roleSessionId) =>
                input.client.session.abort({
                  path: { id: roleSessionId },
                  query: { directory: input.directory },
                }),
              ),
            )
          }
          for (const roleSessionId of recoveredSessions) {
            browserEvidence.forget(roleSessionId)
            roleSessions.delete(roleSessionId)
            workflowSessions.delete(roleSessionId)
            workflows.delete(roleSessionId)
            roleSessionPolicy.revoke(roleSessionId)
          }
          activeWorkflowIds.delete(workflowId)
        }
      })
      const tracked = recovery.then(
        () => undefined,
        () => undefined,
      )
      activeRuns.add(tracked)
      void tracked.then(() => {
        activeRuns.delete(tracked)
        if (restoreParentMapping && workflows.get(sessionId) === workflowId) {
          if (previousWorkflowId === undefined) workflows.delete(sessionId)
          else workflows.set(sessionId, previousWorkflowId)
        }
      })
      return recovery
    },
    async run(
      sessionId: string,
      mode: "auto" | "full" | "quick",
      goalId?: string,
      milestone?: string,
      signal?: AbortSignal,
    ) {
      const activeWorkflowId = activeWorkflowForSession(sessionId, workflows, activeWorkflowIds)
      if (activeWorkflowId !== undefined) {
        return controlPlane.control(projectKey, "status", activeWorkflowId)
      }
      const routed = requestRouter.takeUnarmed(sessionId, mode)
      if (routed !== undefined) {
        const started = await launchWorkflow(sessionId, routed, signal)
        if (goalId !== undefined && milestone !== undefined) {
          await controlPlane.goal(projectKey, {
            goal_id: goalId,
            milestone,
            type: "link_workflow",
            workflow_id: started.workflowId,
          })
        }
        return started
      }
      requestRouter.arm(sessionId, mode)
      return { mode, scope: "next request in this session" }
    },
    setRoutingPreference(sessionId: string, mode: "auto" | "full" | "quick") {
      requestRouter.arm(sessionId, mode)
      return { mode, scope: "next request in this session" }
    },
  }
  const consultations = new RoleConsultations(input.client, {
    directory: input.directory,
    async goalSnapshot(sessionId) {
      try {
        return await controlPlane.goal(projectKey, {
          goal_id: null,
          session_id: sessionId,
          type: "status",
        })
      } catch (error) {
        if (error instanceof Error && error.message.includes("no focused goal")) return null
        throw error
      }
    },
    model: (role, sessionId) => effectiveRoleModels()[role] ?? activeModels.get(sessionId),
    models: {},
    onSessionCreated(sessionId, role) {
      workflowSessions.add(sessionId)
      roleSessions.set(sessionId, role)
      roleSessionPolicy.authorize(sessionId, role)
    },
    variant: (role, sessionId) =>
      effectiveRoleModels()[role] === undefined
        ? activeVariants.get(sessionId)
        : effectiveRoleVariants()[role],
  })

  return {
    tool: {
      [CYCLE_TOOL_NAMES.control]: cycleControlTool(controlPlane, projectKey, setupInspector),
      [CYCLE_TOOL_NAMES.browser]: cycleBrowserTool({
        async execute(sessionId, command, approveExternalOrigin) {
          assertBrowserCommandRole(roleSessionPolicy.role(sessionId), command)
          const result = await browserManager.execute(sessionId, command, approveExternalOrigin)
          if (command.operation === "close" && workflows.get(sessionId) !== undefined) {
            await browserEvidence.recordClose(sessionId, result)
          }
          return result
        },
      }),
      [CYCLE_TOOL_NAMES.role]: cycleRoleTool({
        invoke(sessionId, operation, signal) {
          const request = requestRouter.pending(sessionId)?.originalRequest
          if (request === undefined) {
            throw new Error("Role consultation requires a current exact user request")
          }
          return consultations.invoke(sessionId, operation, request, signal)
        },
      }),
    },
    async config(config: Config) {
      try {
        const next = structuredClone(config)
        removeInjectedRoleModels(next, injectedRoleModels.get(config))
        const candidateNativeRoleModels = roleModelsFromNativeConfig(next)
        const candidateNativeRoleVariants = roleVariantsFromNativeConfig(
          next,
          candidateNativeRoleModels,
        )
        const candidateRoleModels = effectiveRoleModels(candidateNativeRoleModels)
        const candidateInjectedRoleModels = injectedModelsForRegistration(candidateNativeRoleModels)
        registerCycleAgent(next, { models: candidateRoleModels, permissionPreset })
        registerCycleCommand(next)
        if (next.agent === undefined || next.command === undefined) {
          throw new Error("Native OpenCode registration did not produce required configuration")
        }
        config.agent = next.agent
        config.command = next.command
        nativeRoleModels = candidateNativeRoleModels
        nativeRoleVariants = candidateNativeRoleVariants
        injectedRoleModels.set(config, candidateInjectedRoleModels)
        const notice = hostCommandNotice(report)
        if (notice !== undefined) {
          const cycleCommand = config.command?.cycle as
            | { description?: string; template?: string }
            | undefined
          if (cycleCommand !== undefined) {
            cycleCommand.description = `${cycleCommand.description ?? PRODUCT_NAME}. ${notice}`
            cycleCommand.template = `Host notice: ${notice}\n${cycleCommand.template ?? ""}`
          }
        }
        await input.client.app
          .log({
            body: {
              level: report.certified ? "info" : "warn",
              message: `${PRODUCT_NAME} activated`,
              extra: {
                host_certified: report.certified,
                host_version: hostVersion ?? "host-reported",
                product_version: PRODUCT_VERSION,
                ...(notice === undefined ? {} : { host_notice: notice }),
              },
              service: PRODUCT_SERVICE,
            },
          })
          .catch(() => undefined)
      } catch (error) {
        await logSetupFailure(input, error)
      }
    },
    async "command.execute.before"({ arguments: argumentsText, command, sessionID }, output) {
      if (command !== "cycle") return
      let parsed: ReturnType<typeof parseCycleCommand>
      try {
        parsed = parseCycleCommand(argumentsText)
      } catch {
        replaceCommandGuidance(
          output.parts,
          "Cycle for OpenCode did not run the command because it is unknown. Run /cycle help and do not call tools.",
        )
        return
      }
      if (parsed.status === "confirmation-required") {
        replaceCommandGuidance(
          output.parts,
          `Cycle for OpenCode did not run ${parsed.definition.syntax}. This command requires explicit --confirm after user approval. Explain that requirement and do not call tools.`,
        )
        return
      }
      if (parsed.definition.path[0] === "run") {
        const mode = parsed.arguments[0] ?? "auto"
        if (mode !== "auto" && mode !== "quick" && mode !== "full") {
          replaceCommandGuidance(
            output.parts,
            "Cycle for OpenCode did not run /cycle run. The mode must be auto, quick or full. Explain the valid modes and do not call tools.",
          )
          return
        }
        requestRouter.arm(sessionID, mode)
      }
      if (parsed.definition.path[0] === "cancel") {
        const workflowID = workflows.get(sessionID)
        if (workflowID !== undefined) {
          await Promise.allSettled(
            [...roleSessions.keys()]
              .filter((roleSessionID) => workflows.get(roleSessionID) === workflowID)
              .map((roleSessionID) =>
                input.client.session.abort({
                  path: { id: roleSessionID },
                  query: { directory: input.directory },
                }),
              ),
          )
        }
      }
      await controlPlane.health()
      await controlPlane.audit(
        observation(
          { projectKey },
          { action: `command:${parsed.definition.path.join(":")}`, type: "workflow" },
          { arguments_digest: digest(parsed.arguments) },
        ),
      )
    },
    async "chat.message"({ agent, model, sessionID, variant }, output) {
      if (agent !== CYCLE_AGENT_NAME) {
        const role = roleForAgent(agent)
        if (role === undefined) return
        workflowSessions.add(sessionID)
        if (!roleSessions.has(sessionID)) roleSessionPolicy.markDirect(sessionID, role)
        await controlPlane.audit(
          observation(
            {
              projectKey,
              role,
              sessionID,
              ...(model === undefined ? {} : { model }),
              ...(workflows.get(sessionID) === undefined
                ? {}
                : { workflowID: workflows.get(sessionID) as string }),
            },
            { action: "role_request_received", type: "workflow" },
            { request_digest: digest(output.parts) },
          ),
        )
        return
      }
      workflowSessions.add(sessionID)
      roleSessionPolicy.markEntrypoint(sessionID)
      if (model !== undefined) {
        activeModels.set(sessionID, `${model.providerID}/${model.modelID}`)
        if (variant === undefined) activeVariants.delete(sessionID)
        else activeVariants.set(sessionID, variant)
      }
      let workflowID = workflows.get(sessionID)
      const commandMessage = output.parts.some(
        (part) =>
          part.type === "text" &&
          (part.text.startsWith("Execute the native Cycle for OpenCode command with these arguments:") ||
            (part.synthetic === true && part.text.startsWith("Cycle for OpenCode did not run "))),
      )
      if (!commandMessage) {
        const captured = await captureWorkflowRequest(output.parts, input.worktree)
        requestRouter.capture(sessionID, captured)
        const routed = requestRouter.takeArmed(sessionID)
        if (routed !== undefined) {
          workflowID = (await launchWorkflow(sessionID, routed)).workflowId
        }
      }
      await controlPlane.audit(
        observation(
          {
            projectKey,
            sessionID,
            ...(model === undefined ? {} : { model }),
            ...(workflowID === undefined ? {} : { workflowID }),
          },
          { action: "request_received", type: "workflow" },
          { request_digest: digest(output.parts) },
        ),
      )
    },
    async "tool.execute.before"({ callID, sessionID, tool }, output) {
      if (!workflowSessions.has(sessionID)) return
      browserEvidence.invalidate(sessionID)
      try {
        roleSessionPolicy.assertToolAllowed(sessionID, tool)
      } catch (error) {
        await controlPlane.audit(
          observation(
            {
              projectKey,
              sessionID,
              ...(roleSessionPolicy.role(sessionID) === undefined
                ? {}
                : { role: roleSessionPolicy.role(sessionID) as WorkflowRole }),
            },
            { invocation_digest: digest(output.args), tool, type: "tool" },
            { call_id: callID, phase: "denied" },
          ),
        )
        throw error
      }
      await controlPlane.audit(
        observation(
          {
            projectKey,
            sessionID,
            ...(roleSessionPolicy.role(sessionID) === undefined
              ? {}
              : { role: roleSessionPolicy.role(sessionID) as WorkflowRole }),
            ...(workflows.get(sessionID) === undefined
              ? {}
              : { workflowID: workflows.get(sessionID) as string }),
          },
          { invocation_digest: digest(output.args), tool, type: "tool" },
          { call_id: callID, phase: "started" },
        ),
      )
    },
    async "tool.execute.after"({ args, callID, sessionID, tool }, output) {
      if (!workflowSessions.has(sessionID)) return
      await controlPlane.audit(
        observation(
          {
            projectKey,
            sessionID,
            ...(roleSessionPolicy.role(sessionID) === undefined
              ? {}
              : { role: roleSessionPolicy.role(sessionID) as WorkflowRole }),
            ...(workflows.get(sessionID) === undefined
              ? {}
              : { workflowID: workflows.get(sessionID) as string }),
          },
          { invocation_digest: digest(args), tool, type: "tool" },
          {
            call_id: callID,
            output_digest: digest(output.output),
            phase: "completed",
            title: output.title,
          },
        ),
      )
    },
    async "permission.ask"(permission, output) {
      if (!workflowSessions.has(permission.sessionID)) return
      await controlPlane.audit(
        observation(
          { projectKey, sessionID: permission.sessionID },
          { decision: output.status, permission: permission.type, type: "permission" },
          { permission_id: permission.id },
        ),
      )
    },
    async event({ event }) {
      if (event.type !== "permission.replied") return
      if (!workflowSessions.has(event.properties.sessionID)) return
      await controlPlane.audit(
        observation(
          { projectKey, sessionID: event.properties.sessionID },
          { decision: event.properties.response, permission: "permission_reply", type: "permission" },
          { permission_id: event.properties.permissionID },
        ),
      )
    },
    async dispose() {
      shutdown.abort()
      await Promise.allSettled(
        [...roleSessions.keys()].map((sessionID) =>
          input.client.session.abort({
            path: { id: sessionID },
            query: { directory: input.directory },
          }),
        ),
      )
      await Promise.allSettled(activeRuns)
      for (const sessionID of workflowSessions) roleSessionPolicy.revoke(sessionID)
      await browserManager.dispose()
      await controlPlane.dispose()
    },
  }
}

async function runAdmittedWorkflow<Result>(
  controlPlane: LocalControlPlane,
  input: {
    readonly projectKey: string
    readonly signal: AbortSignal
    readonly sourceDirectory: string
    readonly workflowId: string
  },
  run: (codeContext: CodeIndexReceipt["context"]) => Promise<Result>,
): Promise<Result> {
  let receipt: AdmissionReceipt
  for (;;) {
    input.signal.throwIfAborted()
    receipt = await controlPlane.admission(
      input.projectKey,
      input.workflowId,
      input.sourceDirectory,
      "acquire",
    )
    if (receipt.admitted) break
    await interruptibleDelay(receipt.retryAfterMillis, input.signal)
  }
  await controlPlane.audit(
    observation(
      { projectKey: input.projectKey, workflowID: input.workflowId },
      { action: "resource_permit_acquired", type: "workflow" },
      { active: String(receipt.active), maximum_active: String(receipt.maximumActive) },
    ),
  )
  let renewal = Promise.resolve()
  let renewalFailure: unknown
  const timer = setInterval(() => {
    renewal = renewal
      .then(async () => {
        const renewed = await controlPlane.admission(
          input.projectKey,
          input.workflowId,
          input.sourceDirectory,
          "renew",
        )
        if (!renewed.admitted) {
          throw new Error(`Workflow resource permit was lost: ${renewed.reason}`)
        }
      })
      .catch((error: unknown) => {
        renewalFailure ??= error
      })
  }, 5_000)
  try {
    const codeIndex = await controlPlane.codeIndex(
      input.projectKey,
      input.workflowId,
      input.sourceDirectory,
    )
    await controlPlane.audit(
      observation(
        { projectKey: input.projectKey, workflowID: input.workflowId },
        { action: "code_intelligence_ready", type: "workflow" },
        {
          index_digest: digest(codeIndex.index),
          paths: String(codeIndex.context.paths.length),
          scopes: String(codeIndex.context.scopes.length),
        },
      ),
    )
    const result = await run(codeIndex.context)
    await renewal
    if (renewalFailure !== undefined) throw renewalFailure
    return result
  } finally {
    clearInterval(timer)
    await controlPlane.admission(
      input.projectKey,
      input.workflowId,
      input.sourceDirectory,
      "release",
    )
    await controlPlane.audit(
      observation(
        { projectKey: input.projectKey, workflowID: input.workflowId },
        { action: "resource_permit_released", type: "workflow" },
      ),
    )
  }
}

function interruptibleDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener("abort", aborted, { once: true })

    function done() {
      signal.removeEventListener("abort", aborted)
      resolve()
    }

    function aborted() {
      clearTimeout(timer)
      reject(signal.reason)
    }
  })
}

function inspectRoleReasoning(value: unknown): Partial<Record<WorkflowRole, object>> {
  if (!Array.isArray(value)) return {}
  const result: Partial<Record<WorkflowRole, object>> = {}
  for (const role of Object.keys(ROLE_AGENT_NAMES) as WorkflowRole[]) {
    const agent = value.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        (entry as { name?: unknown }).name === ROLE_AGENT_NAMES[role],
    )
    if (typeof agent !== "object" || agent === null || Array.isArray(agent)) continue
    const record = agent as Record<string, unknown>
    const options =
      typeof record.options === "object" && record.options !== null && !Array.isArray(record.options)
        ? (record.options as Record<string, unknown>)
        : {}
    const settings: Record<string, unknown> = {}
    for (const key of ["reasoningEffort", "reasoningSummary", "textVerbosity"] as const) {
      const setting = options[key]
      if (typeof setting === "string" && /^\S{1,64}$/u.test(setting)) settings[key] = setting
    }
    const thinking = inspectThinking(options.thinking)
    if (thinking !== undefined) settings.thinking = thinking
    if (typeof record.variant === "string" && /^\S{1,64}$/u.test(record.variant)) {
      settings.variant = record.variant
    }
    if (Object.keys(settings).length !== 0) result[role] = settings
  }
  return result
}

function inspectThinking(value: unknown): object | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  if (typeof input.type === "string" && /^\S{1,64}$/u.test(input.type)) result.type = input.type
  if (
    typeof input.budgetTokens === "number" &&
    Number.isSafeInteger(input.budgetTokens) &&
    input.budgetTokens >= 0
  ) {
    result.budgetTokens = input.budgetTokens
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = [...new Set(signals.filter((value): value is AbortSignal => value !== undefined))]
  if (present.length === 0) return new AbortController().signal
  if (present.length === 1) return present[0] as AbortSignal
  return AbortSignal.any(present)
}

function roleForAgent(agent: string | undefined): WorkflowRole | undefined {
  return (Object.entries(ROLE_AGENT_NAMES) as [WorkflowRole, string][]).find(
    ([, name]) => name === agent,
  )?.[0]
}

export default OpenCodeCycle
