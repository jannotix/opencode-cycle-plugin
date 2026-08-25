import { createHash, createHmac, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, readFile, realpath } from "node:fs/promises"
import type { Socket } from "node:net"
import { isAbsolute, join, posix, resolve, win32 } from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { createRequire } from "node:module"

import type { ReviewVerdictInput } from "./orchestration/reviewers.js"
import type { ArbiterVerdictInput } from "./orchestration/arbiter.js"
import type { TaskReviewVerdict } from "./orchestration/task-review.js"
import { connectIpcSocket, MAX_IPC_FRAME_BYTES, type IpcFrameReader } from "./ipc-reader.js"

const AUTH_DOMAIN = Buffer.from("opencode-cycle-ipc-auth-v1")
const CANDIDATE_OPERATION_TIMEOUT_MILLIS = 30 * 60_000
const VERIFICATION_RESPONSE_TIMEOUT_MILLIS = 24 * 60 * 60_000
const HEALTH_WAIT_MS = 15_000
const require = createRequire(import.meta.url)

export interface ControlPlaneHealth {
  readonly product_version: string
  readonly protocol_version: number
  readonly schema_mode: "read_write" | "safe_read_only"
  readonly schema_version: number
}

export interface ControlPlaneOptions {
  readonly binaryPath?: string
  readonly dataDirectory?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly expectedProtocolVersion?: number
  readonly onProcessSpawn?: (identity: OwnedProcessIdentity) => Promise<void>
  readonly platform?: NodeJS.Platform
  readonly processExitMarkerPath?: string
  readonly processOwnerToken?: string
  readonly processRunDigest?: string
  readonly processRuntimeMarkerPath?: string
  readonly stopOwnedProcessOnDispose?: boolean
}

export interface OwnedProcessIdentity {
  readonly binaryPath: string
  readonly pid: number
  readonly startToken: string
  readonly startedAtUnixMillis: number
}

export interface CertifiedShutdownReceipt {
  readonly pid: number
  readonly processStartTimeUnixMillis: number
  readonly runDigest: string
}

export interface AuditObservation {
  readonly actor_id: string
  readonly candidate_id: string | null
  readonly data:
    | { readonly type: "workflow"; readonly action: string }
    | { readonly type: "tool"; readonly invocation_digest: string; readonly tool: string }
    | { readonly type: "permission"; readonly decision: string; readonly permission: string }
    | { readonly type: "git"; readonly externally_attributed: boolean; readonly revision: string }
    | { readonly type: "verification"; readonly gate: string; readonly status: string }
  readonly evidence_ids: readonly string[]
  readonly files: readonly string[]
  readonly metadata: Readonly<Record<string, string>>
  readonly model: { readonly model: string; readonly provider: string } | null
  readonly project_key: string
  readonly role:
    | "architect"
    | "executor"
    | "functional_reviewer"
    | "security_architecture_reviewer"
    | "arbiter"
    | null
  readonly session_id: string | null
  readonly task_id: string | null
  readonly timestamp_unix_millis: number
  readonly workflow_id: string | null
}

export interface AuditReceipt {
  readonly entryHash: string
  readonly sequence: number
}

export type HistoryOperation =
  | { readonly type: "export" }
  | { readonly type: "query"; readonly after_sequence: number | null; readonly limit: number }
  | { readonly type: "verify" }

export type MemoryOperation =
  | { readonly type: "explain"; readonly memory_id: string }
  | { readonly type: "remove"; readonly memory_id: string }
  | {
      readonly type: "search"
      readonly confidence: "inferred" | "user_asserted" | "verified" | null
      readonly limit: number
      readonly scope: string | null
      readonly text: string
    }

export type ControlOperation =
  | "cancel"
  | "doctor"
  | "evidence"
  | "pause"
  | "recovery"
  | "resume"
  | "retry"
  | "status"
  | "tasks"

export type GoalControlAction =
  | "start_planning"
  | "mark_ready"
  | "activate"
  | "pause"
  | "resume"
  | "block"
  | "resume_blocked"
  | "continue"
  | "request_completion"
  | "approve_completion"
  | "reject_completion"
  | "abort"

export type GoalOperation =
  | {
      readonly type: "create"
      readonly constraints: readonly string[]
      readonly goal_id: string
      readonly max_continuations: number
      readonly non_goals: readonly string[]
      readonly objective: string
      readonly session_id: string
      readonly success_criteria: readonly string[]
    }
  | { readonly type: "amend"; readonly goal_id: string; readonly operation_id: string; readonly text: string }
  | {
      readonly type: "control"
      readonly action: GoalControlAction
      readonly completion_evidence: string | null
      readonly goal_id: string
      readonly operation_id: string
      readonly reason: string | null
    }
  | { readonly type: "focus"; readonly goal_id: string; readonly session_id: string }
  | { readonly type: "link_workflow"; readonly goal_id: string; readonly milestone: string; readonly workflow_id: string }
  | { readonly type: "list" }
  | { readonly type: "save_plan"; readonly content: string; readonly goal_id: string; readonly source_session_id: string }
  | { readonly type: "status"; readonly goal_id: string | null; readonly session_id: string }

export type AdmissionOperation = "acquire" | "release" | "renew"

export interface AdmissionReceipt {
  readonly active: number
  readonly admitted: boolean
  readonly leaseExpiresUnixMillis: number | null
  readonly maximumActive: number
  readonly reason: string | null
  readonly retryAfterMillis: number
}

export interface CodeIndexReceipt {
  readonly context: {
    readonly nodes: readonly unknown[]
    readonly paths: readonly string[]
    readonly scopes: readonly string[]
    readonly truncated: boolean
  }
  readonly index: Readonly<Record<string, unknown>>
}

export interface WorkflowStartRequest {
  readonly affectedPaths?: readonly string[]
  readonly attachmentHashes?: readonly string[]
  readonly criticalDowngradeApproval?: string
  readonly originalRequest: string
  readonly preference?: "auto" | "quick" | "full"
  readonly projectKey: string
  readonly workflowId?: string
}

export interface WorkflowStartReceipt {
  readonly mode: "quick" | "full"
  readonly requestDigest: string
  readonly workflowId: string
}

export interface ManagedWorktree {
  readonly baseRevision: string
  readonly path: string
}

export interface PromotionReceipt {
  readonly changedPaths: readonly string[]
  readonly workflowState: string
}

export interface CandidateManifestInput {
  readonly base_revision: string | null
  readonly candidate_id: string
  readonly configuration_digest: string
  readonly dependency_state_digest: string
  readonly diff_digest: string
  readonly environment_digest: string
  readonly evidence_ids: readonly string[]
  readonly files: readonly {
    readonly digest: string | null
    readonly kind: "added" | "deleted" | "generated" | "modified"
    readonly path: string
  }[]
}

export interface CandidateFreezeReceipt {
  readonly candidateDigest: string
  readonly candidateId: string
  readonly manifest: CandidateManifestInput
}

export interface VerificationPlanReceipt {
  readonly evidenceIds: readonly string[]
  readonly planId: string
}

export interface ManagedBrowserAttestationInput {
  readonly candidate_digest: string
  readonly receipt_digest: string
  readonly receipt_json: string
  readonly session_id: string
}

export interface EvidenceRecordInput {
  readonly candidate_digest: string
  readonly exit_code: number | null
  readonly finished_at: string
  readonly id: string
  readonly invocation: string
  readonly kind:
    | "browser"
    | "build"
    | "command"
    | "database"
    | "inspection"
    | "lint"
    | "package"
    | "security"
    | "test"
  readonly output_digest: string
  readonly skip_reason: string | null
  readonly started_at: string
  readonly status: "failed" | "passed" | "skipped"
  readonly tool: string
  readonly tool_version: string
}

export interface VerificationReceipt {
  readonly evidence: readonly {
    readonly output: string
    readonly record: EvidenceRecordInput
  }[]
  readonly mandatoryPassed: boolean
  readonly workflowState: string
}

export interface ReviewReceipt {
  readonly reviewsReady: boolean
}

export interface ArbitrationReceiptInput {
  readonly arbiter_verdict_digest: string
  readonly candidate_digest: string
  readonly candidate_id: string
  readonly evidence_ids: readonly string[]
  readonly finalized_at: string
  readonly functional_review_digest: string | null
  readonly id: string
  readonly request_digest: string
  readonly security_review_digest: string | null
  readonly workflow_id: string
}

export interface ArbitrationResult {
  readonly decision: "approved" | "rejected"
  readonly receipt: ArbitrationReceiptInput
  readonly receiptDigest: string
  readonly workflowState: string
}

export interface ArchitecturePlanInput {
  readonly assumptions: readonly string[]
  readonly integration_checks: readonly string[]
  readonly request_digest: string
  readonly requirements: readonly {
    readonly acceptance_criteria: readonly string[]
    readonly id: string
    readonly statement: string
  }[]
  readonly risks: readonly string[]
  readonly tasks: readonly {
    readonly acceptance_criteria: readonly string[]
    readonly dependencies: readonly string[]
    readonly id: string
    readonly objective: string
    readonly requirement_ids: readonly string[]
    readonly title: string
    readonly verification_commands: readonly string[]
    readonly write_scopes: readonly string[]
  }[]
}

export interface TaskClosureReportInput {
  readonly architecture_digest: string
  readonly base_revision: string
  readonly changed_paths: readonly string[]
  readonly commands: readonly {
    readonly evidence_id: string
    readonly exit_code: number
    readonly invocation: string
    readonly output_digest: string
    readonly status: "failed" | "passed" | "timeout"
  }[]
  readonly receipt_id: string
  readonly request_digest: string
  readonly reviewer: {
    readonly verdict: TaskReviewVerdict
    readonly verdict_digest: string
  }
  readonly submitted_revision: string
  readonly task_id: string
}

export interface TaskClosureReceipt {
  readonly duplicate: boolean
  readonly taskId: string
  readonly taskState: "completed"
  readonly workflowId: string
}

export class ControlPlaneError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ControlPlaneError"
  }
}

export class LocalControlPlane {
  readonly #architecture: string
  readonly #binaryPath: string | undefined
  readonly #dataDirectory: string
  readonly #endpoint: string
  readonly #expectedProtocolVersion: number
  readonly #onProcessSpawn: ((identity: OwnedProcessIdentity) => Promise<void>) | undefined
  readonly #platform: NodeJS.Platform
  readonly #processExitMarkerPath: string | undefined
  readonly #processOwnerToken: string | undefined
  readonly #processRunDigest: string | undefined
  readonly #processRuntimeMarkerPath: string | undefined
  readonly #secretPath: string
  readonly #stopOwnedProcessOnDispose: boolean
  #ownedProcess: ChildProcess | undefined
  #ownedProcessIdentity: OwnedProcessIdentity | undefined

  constructor(options: ControlPlaneOptions = {}) {
    const platform = options.platform ?? process.platform
    this.#platform = platform
    this.#architecture = process.arch
    this.#dataDirectory =
      options.dataDirectory ?? resolveDataDirectory(platform, options.environment ?? process.env)
    this.#binaryPath = options.binaryPath
    this.#secretPath = join(this.#dataDirectory, "runtime", "ipc.secret")
    this.#endpoint =
      platform === "win32" ? "" : join(this.#dataDirectory, "runtime", "workflow.sock")
    this.#expectedProtocolVersion = options.expectedProtocolVersion ?? 1
    this.#onProcessSpawn = options.onProcessSpawn
    this.#processExitMarkerPath = options.processExitMarkerPath
    this.#processOwnerToken = options.processOwnerToken
    this.#processRunDigest = options.processRunDigest
    this.#processRuntimeMarkerPath = options.processRuntimeMarkerPath
    this.#stopOwnedProcessOnDispose = options.stopOwnedProcessOnDispose ?? false
    const certificationBindings = [
      this.#processOwnerToken,
      this.#processRunDigest,
      this.#processRuntimeMarkerPath,
      this.#processExitMarkerPath,
    ]
    const hasCertificationBinding = certificationBindings.some((value) => value !== undefined)
    const certificationMarkersCollide =
      this.#processRuntimeMarkerPath !== undefined &&
      this.#processExitMarkerPath !== undefined &&
      (this.#platform === "win32"
        ? this.#processRuntimeMarkerPath.toLowerCase() === this.#processExitMarkerPath.toLowerCase()
        : this.#processRuntimeMarkerPath === this.#processExitMarkerPath)
    if (
      (this.#processOwnerToken !== undefined && !SHA256.test(this.#processOwnerToken)) ||
      (this.#processRunDigest !== undefined && !SHA256.test(this.#processRunDigest)) ||
      (this.#onProcessSpawn !== undefined && this.#processOwnerToken === undefined) ||
      (this.#processOwnerToken !== undefined && !this.#stopOwnedProcessOnDispose) ||
      (hasCertificationBinding && certificationBindings.some((value) => value === undefined)) ||
      (this.#processRuntimeMarkerPath !== undefined && (
        !isAbsolute(this.#processRuntimeMarkerPath) ||
        resolve(this.#processRuntimeMarkerPath) !== this.#processRuntimeMarkerPath ||
        this.#processRuntimeMarkerPath.includes("\0")
      )) ||
      (this.#processExitMarkerPath !== undefined && (
        !isAbsolute(this.#processExitMarkerPath) ||
        resolve(this.#processExitMarkerPath) !== this.#processExitMarkerPath ||
        this.#processExitMarkerPath.includes("\0") ||
        certificationMarkersCollide
      ))
    ) {
      throw new ControlPlaneError("workflowd process ownership binding is invalid")
    }
  }

  async nativeBinaryPath(): Promise<string> {
    const configuredBinaryPath =
      this.#binaryPath ?? packagedBinaryPath(this.#platform, this.#architecture)
    await access(configuredBinaryPath, constants.X_OK).catch((cause: unknown) => {
      throw new ControlPlaneError(`workflowd binary is unavailable: ${configuredBinaryPath}`, { cause })
    })
    return realpath(configuredBinaryPath)
  }

  async health(): Promise<ControlPlaneHealth> {
    const existing = await readSecret(this.#secretPath)
    let lastError: unknown
    if (existing !== undefined) {
      try {
        return await this.#query(existing)
      } catch (error) {
        if (error instanceof ControlPlaneError && error.message.includes("protocol")) throw error
        lastError = error
        await this.#reclaimStaleDaemon()
      }
    }

    return this.#spawnAndWait(lastError)
  }

  async #spawnAndWait(previousError: unknown): Promise<ControlPlaneHealth> {
    let lastError = previousError
    if (
      this.#ownedProcess === undefined ||
      this.#ownedProcess.exitCode !== null ||
      this.#ownedProcess.signalCode !== null
    ) {
      const binaryPath = await this.nativeBinaryPath()
      const startedAtUnixMillis = Date.now()
      const argumentsList = ["--data-dir", this.#dataDirectory]
      if (this.#processOwnerToken !== undefined) {
        argumentsList.push(
          "--certification-owner-token",
          this.#processOwnerToken,
          "--certification-runtime-marker",
          this.#processRuntimeMarkerPath as string,
          "--certification-exit-marker",
          this.#processExitMarkerPath as string,
          "--certification-run-digest",
          this.#processRunDigest as string,
        )
      }
      this.#ownedProcess = spawn(binaryPath, argumentsList, {
        detached: !this.#stopOwnedProcessOnDispose,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      })
      const pid = this.#ownedProcess.pid
      if (!Number.isSafeInteger(pid) || (pid as number) < 1) {
        this.#ownedProcess.kill()
        this.#ownedProcess = undefined
        throw new ControlPlaneError("workflowd did not expose a valid process identity")
      }
      if (this.#processOwnerToken !== undefined) {
        this.#ownedProcessIdentity = {
          binaryPath,
          pid: pid as number,
          startToken: this.#processOwnerToken,
          startedAtUnixMillis,
        }
        try {
          await this.#onProcessSpawn?.(this.#ownedProcessIdentity)
        } catch (cause) {
          await this.dispose()
          throw new ControlPlaneError("workflowd ownership publication failed", { cause })
        }
      }
      if (!this.#stopOwnedProcessOnDispose) this.#ownedProcess.unref()
    }

    const deadline = Date.now() + HEALTH_WAIT_MS
    while (Date.now() < deadline) {
      const secret = await readSecret(this.#secretPath)
      if (secret !== undefined) {
        try {
          return await this.#query(secret)
        } catch (error) {
          lastError = error
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new ControlPlaneError("workflowd did not become healthy within 15 seconds", {
      cause: lastError,
    })
  }

  async #reclaimStaleDaemon(): Promise<void> {
    const child = this.#ownedProcess
    this.#ownedProcess = undefined
    this.#ownedProcessIdentity = undefined
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill()
    }
    const pidPath = join(this.#dataDirectory, "runtime", "workflowd.pid")
    const raw = await readFile(pidPath, "utf8").catch(() => "")
    const pid = Number.parseInt(raw.trim(), 10)
    if (
      this.#processOwnerToken === undefined &&
      Number.isInteger(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      pid !== child?.pid
    ) {
      try {
        process.kill(pid)
      } catch {
        if (this.#platform === "win32") {
          spawnSync("taskkill", ["/F", "/PID", String(pid)], {
            shell: false,
            stdio: "ignore",
            windowsHide: true,
          })
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  async dispose(): Promise<void> {
    if (this.#stopOwnedProcessOnDispose && this.#ownedProcess !== undefined) {
      const child = this.#ownedProcess
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        if (!await waitForChildExit(child, 2_000)) {
          child.kill("SIGKILL")
          if (!await waitForChildExit(child, 3_000)) {
            throw new ControlPlaneError("workflowd owned process did not exit during disposal")
          }
        }
      }
    }
    this.#ownedProcess = undefined
    this.#ownedProcessIdentity = undefined
  }

  ownedProcessIdentity(): OwnedProcessIdentity {
    const identity = this.#ownedProcessIdentity
    const process = this.#ownedProcess
    if (
      identity === undefined ||
      process === undefined ||
      process.pid !== identity.pid ||
      process.exitCode !== null ||
      process.signalCode !== null
    ) {
      throw new ControlPlaneError("workflowd owned process identity is unavailable")
    }
    return identity
  }

  async shutdownOwned(ownerToken: string, runDigest: string): Promise<CertifiedShutdownReceipt> {
    if (!SHA256.test(ownerToken) || !SHA256.test(runDigest)) {
      throw new ControlPlaneError("workflowd shutdown binding is invalid")
    }
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd shutdown endpoint is unavailable")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(await writeJsonAndRead(decoder, {
        data: { owner_token: ownerToken, request_id: 19, run_digest: runDigest },
        type: "shutdown",
      }))
      if (message.type !== "shutdown") throw new ControlPlaneError("workflowd rejected authenticated shutdown")
      const data = asRecord(message.data)
      if (
        data.request_id !== 19 ||
        data.run_digest !== runDigest ||
        typeof data.pid !== "number" ||
        !Number.isSafeInteger(data.pid) ||
        typeof data.process_start_time_unix_millis !== "number" ||
        !Number.isSafeInteger(data.process_start_time_unix_millis)
      ) throw new ControlPlaneError("workflowd returned a malformed shutdown receipt")
      return {
        pid: data.pid,
        processStartTimeUnixMillis: data.process_start_time_unix_millis,
        runDigest,
      }
    } finally {
      socket.destroy()
    }
  }

  async audit(observation: AuditObservation): Promise<AuditReceipt> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(decoder, {
          data: { observation, request_id: 2 },
          type: "audit",
        }),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the audit event",
        )
      }
      if (message.type !== "audit_recorded") {
        throw new ControlPlaneError("workflowd returned an unexpected audit response")
      }
      const data = asRecord(message.data)
      if (
        data.request_id !== 2 ||
        !Number.isSafeInteger(data.sequence) ||
        typeof data.entry_hash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(data.entry_hash)
      ) {
        throw new ControlPlaneError("workflowd returned a malformed audit receipt")
      }
      return { entryHash: data.entry_hash, sequence: data.sequence as number }
    } finally {
      socket.destroy()
    }
  }

  async history(projectKey: string, operation: HistoryOperation): Promise<unknown> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(decoder, {
          data: { operation, project_key: projectKey, request_id: 3 },
          type: "history",
        }),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the history request",
        )
      }
      if (message.type !== "history") {
        throw new ControlPlaneError("workflowd returned an unexpected history response")
      }
      const data = asRecord(message.data)
      if (data.request_id !== 3 || !("result" in data)) {
        throw new ControlPlaneError("workflowd returned a malformed history response")
      }
      return data.result
    } finally {
      socket.destroy()
    }
  }

  async goal(projectKey: string, operation: GoalOperation): Promise<unknown> {
    await this.health()
    if (!projectKey) throw new ControlPlaneError("goal operation requires a project key")
    const data = await this.#exchange(16, "goal", "goal", {
      operation,
      project_key: projectKey,
    })
    if (!("result" in data)) {
      throw new ControlPlaneError("workflowd returned a malformed goal response")
    }
    return data.result
  }

  async control(
    projectKey: string,
    operation: ControlOperation,
    workflowId?: string,
  ): Promise<unknown> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(decoder, {
          data: {
            operation,
            operation_id: randomUUID(),
            project_key: projectKey,
            request_id: 12,
            workflow_id: workflowId ?? null,
          },
          type: "control",
        }),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the control request",
        )
      }
      if (message.type !== "control") {
        throw new ControlPlaneError("workflowd returned an unexpected control response")
      }
      const data = asRecord(message.data)
      if (data.request_id !== 12 || !("result" in data)) {
        throw new ControlPlaneError("workflowd returned a malformed control response")
      }
      return data.result
    } finally {
      socket.destroy()
    }
  }

  async admission(
    projectKey: string,
    workflowId: string,
    workspace: string,
    operation: AdmissionOperation,
  ): Promise<AdmissionReceipt> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(decoder, {
          data: {
            operation,
            project_key: projectKey,
            request_id: 13,
            workflow_id: workflowId,
            workspace,
          },
          type: "admission",
        }),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string"
            ? data.message
            : "workflowd rejected the admission request",
        )
      }
      if (message.type !== "admission") {
        throw new ControlPlaneError("workflowd returned an unexpected admission response")
      }
      const data = asRecord(message.data)
      const result = asRecord(data.result)
      if (
        data.request_id !== 13 ||
        typeof result.admitted !== "boolean" ||
        !Number.isSafeInteger(result.active) ||
        !Number.isSafeInteger(result.maximumActive) ||
        !Number.isSafeInteger(result.retryAfterMillis) ||
        (result.leaseExpiresUnixMillis !== null &&
          !Number.isSafeInteger(result.leaseExpiresUnixMillis)) ||
        (result.reason !== null && typeof result.reason !== "string")
      ) {
        throw new ControlPlaneError("workflowd returned a malformed admission response")
      }
      return result as unknown as AdmissionReceipt
    } finally {
      socket.destroy()
    }
  }

  async codeIndex(
    projectKey: string,
    workflowId: string,
    projectDirectory: string,
  ): Promise<CodeIndexReceipt> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(
          decoder,
          {
            data: {
              project_directory: projectDirectory,
              project_key: projectKey,
              request_id: 14,
              workflow_id: workflowId,
            },
            type: "code_index",
          },
          30 * 60_000,
        ),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the code index",
        )
      }
      if (message.type !== "code_index") {
        throw new ControlPlaneError("workflowd returned an unexpected code index response")
      }
      const data = asRecord(message.data)
      const result = asRecord(data.result)
      const context = asRecord(result.context)
      if (
        data.request_id !== 14 ||
        !Array.isArray(context.nodes) ||
        !Array.isArray(context.paths) ||
        context.paths.some((path) => typeof path !== "string") ||
        !Array.isArray(context.scopes) ||
        context.scopes.some((scope) => typeof scope !== "string") ||
        typeof context.truncated !== "boolean" ||
        typeof result.index !== "object" ||
        result.index === null
      ) {
        throw new ControlPlaneError("workflowd returned a malformed code index response")
      }
      return result as unknown as CodeIndexReceipt
    } finally {
      socket.destroy()
    }
  }

  async promoteCandidate(
    projectKey: string,
    workflowId: string,
    candidateId: string,
    projectDirectory: string,
  ): Promise<PromotionReceipt> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(
          decoder,
          {
            data: {
              candidate_id: candidateId,
              project_directory: projectDirectory,
              project_key: projectKey,
              request_id: 15,
              workflow_id: workflowId,
            },
            type: "promote_candidate",
          },
          CANDIDATE_OPERATION_TIMEOUT_MILLIS,
        ),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string"
            ? data.message
            : "workflowd rejected candidate delivery",
        )
      }
      if (message.type !== "candidate_promoted") {
        throw new ControlPlaneError("workflowd returned an unexpected candidate delivery response")
      }
      const data = asRecord(message.data)
      if (
        data.request_id !== 15 ||
        data.workflow_id !== workflowId ||
        !Array.isArray(data.changed_paths) ||
        data.changed_paths.some((path) => typeof path !== "string") ||
        typeof data.workflow_state !== "string"
      ) {
        throw new ControlPlaneError("workflowd returned a malformed candidate delivery response")
      }
      return {
        changedPaths: data.changed_paths,
        workflowState: data.workflow_state,
      } as PromotionReceipt
    } finally {
      socket.destroy()
    }
  }

  async memory(projectKey: string, operation: MemoryOperation): Promise<unknown> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(decoder, {
          data: { operation, project_key: projectKey, request_id: 4 },
          type: "memory",
        }),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the memory request",
        )
      }
      if (message.type !== "memory") {
        throw new ControlPlaneError("workflowd returned an unexpected memory response")
      }
      const data = asRecord(message.data)
      if (data.request_id !== 4 || !("result" in data)) {
        throw new ControlPlaneError("workflowd returned a malformed memory response")
      }
      return data.result
    } finally {
      socket.destroy()
    }
  }

  async startWorkflow(request: WorkflowStartRequest): Promise<WorkflowStartReceipt> {
    await this.health()
    if (!request.originalRequest || !request.projectKey) {
      throw new ControlPlaneError("workflow start requires an original request and project key")
    }
    const attachmentHashes = [...(request.attachmentHashes ?? [])]
    if (attachmentHashes.some((hash) => !/^[0-9a-f]{64}$/u.test(hash))) {
      throw new ControlPlaneError("workflow attachment digest is invalid")
    }
    const workflowId = request.workflowId ?? randomUUID()
    const envelope = {
      payload: {
        data: {
          amendments: [],
          attachment_hashes: attachmentHashes,
          original_text: request.originalRequest,
        },
        type: "request",
      },
      version: 1,
    }
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(decoder, {
          data: {
            affected_paths: [...(request.affectedPaths ?? [])],
            critical_downgrade_approval: request.criticalDowngradeApproval ?? null,
            envelope,
            project_key: request.projectKey,
            request_id: 5,
            routing_preference: request.preference ?? "auto",
            workflow_id: workflowId,
          },
          type: "request",
        }),
      )
      if (message.type !== "response") {
        throw new ControlPlaneError("workflowd returned an unexpected workflow response")
      }
      const data = asRecord(message.data)
      if (data.status === "rejected") {
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the workflow",
        )
      }
      if (
        data.status !== "accepted" ||
        data.request_id !== 5 ||
        data.workflow_id !== workflowId ||
        typeof data.request_digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(data.request_digest) ||
        (data.mode !== "quick" && data.mode !== "full")
      ) {
        throw new ControlPlaneError("workflowd returned a malformed workflow receipt")
      }
      return {
        mode: data.mode,
        requestDigest: data.request_digest,
        workflowId,
      }
    } finally {
      socket.destroy()
    }
  }

  async submitArchitecture(
    projectKey: string,
    workflowId: string,
    plan: ArchitecturePlanInput,
  ): Promise<void> {
    await this.health()
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(decoder, {
          data: {
            affected_paths: [],
            critical_downgrade_approval: null,
            envelope: { payload: { data: plan, type: "architecture" }, version: 1 },
            project_key: projectKey,
            request_id: 6,
            routing_preference: "auto",
            workflow_id: workflowId,
          },
          type: "request",
        }),
      )
      if (message.type !== "response") {
        throw new ControlPlaneError("workflowd returned an unexpected architecture response")
      }
      const data = asRecord(message.data)
      if (data.status === "rejected") {
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the architecture",
        )
      }
      if (
        data.status !== "accepted" ||
        data.request_id !== 6 ||
        data.workflow_id !== workflowId ||
        data.request_digest !== plan.request_digest ||
        (data.mode !== "full" && data.mode !== "quick")
      ) {
        throw new ControlPlaneError("workflowd returned a malformed architecture receipt")
      }
    } finally {
      socket.destroy()
    }
  }

  async prepareWorktree(
    projectKey: string,
    projectDirectory: string,
    workflowId: string,
  ): Promise<ManagedWorktree> {
    await this.health()
    if (!projectKey || !projectDirectory || !workflowId) {
      throw new ControlPlaneError("worktree preparation requires project and workflow identity")
    }
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(
          decoder,
          {
            data: {
              project_directory: projectDirectory,
              project_key: projectKey,
              request_id: 7,
              workflow_id: workflowId,
            },
            type: "worktree",
          },
          CANDIDATE_OPERATION_TIMEOUT_MILLIS,
        ),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the worktree",
        )
      }
      if (message.type !== "worktree") {
        throw new ControlPlaneError("workflowd returned an unexpected worktree response")
      }
      const data = asRecord(message.data)
      if (
        data.request_id !== 7 ||
        data.workflow_id !== workflowId ||
        typeof data.path !== "string" ||
        !data.path ||
        typeof data.base_revision !== "string" ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(data.base_revision)
      ) {
        throw new ControlPlaneError("workflowd returned a malformed worktree response")
      }
      return { baseRevision: data.base_revision, path: data.path }
    } finally {
      socket.destroy()
    }
  }

  async freezeCandidate(
    projectKey: string,
    workflowId: string,
    baseRevision: string,
    planId: string,
    evidenceIds: readonly string[],
    candidateId = randomUUID(),
  ): Promise<CandidateFreezeReceipt> {
    await this.health()
    if (!projectKey || !workflowId || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseRevision)) {
      throw new ControlPlaneError("candidate freeze identity is invalid")
    }
    if (evidenceIds.some((id) => !UUID.test(id)) || !UUID.test(candidateId) || !UUID.test(planId)) {
      throw new ControlPlaneError("candidate or evidence identifier is invalid")
    }
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(
          decoder,
          {
            data: {
              base_revision: baseRevision,
              candidate_id: candidateId,
              evidence_ids: [...evidenceIds],
              plan_id: planId,
              project_key: projectKey,
              request_id: 8,
              workflow_id: workflowId,
            },
            type: "freeze_candidate",
          },
          CANDIDATE_OPERATION_TIMEOUT_MILLIS,
        ),
      )
      if (message.type === "error") {
        const data = asRecord(message.data)
        throw new ControlPlaneError(
          typeof data.message === "string" ? data.message : "workflowd rejected the candidate",
        )
      }
      if (message.type !== "candidate_frozen") {
        throw new ControlPlaneError("workflowd returned an unexpected candidate response")
      }
      const data = asRecord(message.data)
      if (
        data.request_id !== 8 ||
        data.workflow_id !== workflowId ||
        data.candidate_id !== candidateId ||
        typeof data.candidate_digest !== "string" ||
        !SHA256.test(data.candidate_digest)
      ) {
        throw new ControlPlaneError("workflowd returned a malformed candidate receipt")
      }
      const manifest = parseCandidateManifest(data.manifest)
      if (manifest.candidate_id !== candidateId) {
        throw new ControlPlaneError("workflowd candidate manifest identity mismatch")
      }
      return {
        candidateDigest: data.candidate_digest,
        candidateId,
        manifest,
      }
    } finally {
      socket.destroy()
    }
  }

  async planVerification(
    projectKey: string,
    workflowId: string,
    planId = randomUUID(),
  ): Promise<VerificationPlanReceipt> {
    await this.health()
    if (!projectKey || !UUID.test(workflowId) || !UUID.test(planId)) {
      throw new ControlPlaneError("verification plan identity is invalid")
    }
    const data = await this.#exchange(9, "plan_verification", "verification_planned", {
      plan_id: planId,
      project_key: projectKey,
      workflow_id: workflowId,
    })
    if (
      data.plan_id !== planId ||
      data.workflow_id !== workflowId ||
      !Array.isArray(data.evidence_ids) ||
      data.evidence_ids.some((id) => typeof id !== "string" || !UUID.test(id))
    ) {
      throw new ControlPlaneError("workflowd returned a malformed verification plan")
    }
    return { evidenceIds: data.evidence_ids as string[], planId }
  }

  async verifyCandidate(
    projectKey: string,
    workflowId: string,
    candidateId: string,
    planId: string,
    attestations: readonly ManagedBrowserAttestationInput[] = [],
  ): Promise<VerificationReceipt> {
    await this.health()
    if (![workflowId, candidateId, planId].every((id) => UUID.test(id)) || !projectKey) {
      throw new ControlPlaneError("verification identity is invalid")
    }
    if (
      attestations.length > 32 ||
      attestations.some(
        (attestation) =>
          !SHA256.test(attestation.candidate_digest) ||
          !SHA256.test(attestation.receipt_digest) ||
          !attestation.receipt_json ||
          Buffer.byteLength(attestation.receipt_json) > 2 * 1024 * 1024 ||
          !attestation.session_id ||
          attestation.session_id.length > 256,
      )
    ) {
      throw new ControlPlaneError("managed browser attestation is invalid")
    }
    const data = await this.#exchange(
      10,
      "verify_candidate",
      "verification_completed",
      {
        attestations,
        candidate_id: candidateId,
        plan_id: planId,
        project_key: projectKey,
        workflow_id: workflowId,
      },
      VERIFICATION_RESPONSE_TIMEOUT_MILLIS,
    )
    if (
      data.candidate_id !== candidateId ||
      data.workflow_id !== workflowId ||
      typeof data.mandatory_passed !== "boolean" ||
      typeof data.workflow_state !== "string" ||
      !Array.isArray(data.evidence)
    ) {
      throw new ControlPlaneError("workflowd returned a malformed verification receipt")
    }
    return {
      evidence: data.evidence.map((value) => {
        const evidence = asRecord(value)
        if (typeof evidence.output !== "string") {
          throw new ControlPlaneError("workflowd returned malformed evidence output")
        }
        return { output: evidence.output, record: parseEvidenceRecord(evidence.record) }
      }),
      mandatoryPassed: data.mandatory_passed,
      workflowState: data.workflow_state,
    }
  }

  async submitReview(
    projectKey: string,
    workflowId: string,
    candidateId: string,
    verdict: ReviewVerdictInput,
  ): Promise<ReviewReceipt> {
    await this.health()
    if (![workflowId, candidateId].every((id) => UUID.test(id)) || !projectKey) {
      throw new ControlPlaneError("review identity is invalid")
    }
    const data = await this.#exchange(11, "submit_review", "review_recorded", {
      candidate_id: candidateId,
      project_key: projectKey,
      verdict,
      workflow_id: workflowId,
    })
    if (
      data.candidate_id !== candidateId ||
      data.workflow_id !== workflowId ||
      typeof data.reviews_ready !== "boolean"
    ) {
      throw new ControlPlaneError("workflowd returned a malformed review receipt")
    }
    return { reviewsReady: data.reviews_ready }
  }

  async submitArbitration(
    projectKey: string,
    workflowId: string,
    candidateId: string,
    verdict: ArbiterVerdictInput,
  ): Promise<ArbitrationResult> {
    await this.health()
    if (![workflowId, candidateId].every((id) => UUID.test(id)) || !projectKey) {
      throw new ControlPlaneError("arbitration identity is invalid")
    }
    const data = await this.#exchange(12, "submit_arbitration", "arbitration_recorded", {
      candidate_id: candidateId,
      project_key: projectKey,
      verdict,
      workflow_id: workflowId,
    })
    if (
      (data.decision !== "approved" && data.decision !== "rejected") ||
      typeof data.receipt_digest !== "string" ||
      !SHA256.test(data.receipt_digest) ||
      typeof data.workflow_state !== "string" ||
      data.workflow_id !== workflowId
    ) {
      throw new ControlPlaneError("workflowd returned a malformed arbitration result")
    }
    const receipt = parseArbitrationReceipt(data.receipt)
    if (receipt.workflow_id !== workflowId || receipt.candidate_id !== candidateId) {
      throw new ControlPlaneError("workflowd arbitration receipt identity mismatch")
    }
    return {
      decision: data.decision,
      receipt,
      receiptDigest: data.receipt_digest,
      workflowState: data.workflow_state,
    }
  }

  async reportExecution(
    projectKey: string,
    workflowId: string,
    outcome: "blocked" | "plan_defect",
  ): Promise<string> {
    await this.health()
    if (!projectKey || !UUID.test(workflowId)) {
      throw new ControlPlaneError("execution report identity is invalid")
    }
    const data = await this.#exchange(13, "report_execution", "execution_reported", {
      outcome,
      project_key: projectKey,
      report_id: randomUUID(),
      workflow_id: workflowId,
    })
    if (data.workflow_id !== workflowId || typeof data.workflow_state !== "string") {
      throw new ControlPlaneError("workflowd returned a malformed execution report")
    }
    return data.workflow_state
  }

  async reportTaskClosure(
    projectKey: string,
    workflowId: string,
    report: TaskClosureReportInput,
  ): Promise<TaskClosureReceipt> {
    await this.health()
    validateTaskClosureReport(projectKey, workflowId, report)
    const data = await this.#exchange(18, "report_task_closure", "task_closure_recorded", {
      report: { ...report, project_key: projectKey, workflow_id: workflowId },
    })
    if (
      data.workflow_id !== workflowId ||
      data.task_id !== report.task_id ||
      data.task_state !== "completed" ||
      typeof data.duplicate !== "boolean"
    ) {
      throw new ControlPlaneError("workflowd returned a malformed task closure receipt")
    }
    return {
      duplicate: data.duplicate,
      taskId: report.task_id,
      taskState: "completed",
      workflowId,
    }
  }

  async #query(secret: Buffer): Promise<ControlPlaneHealth> {
    const { decoder, socket } = await this.#connect(secret)
    try {
      const healthMessage = asRecord(
        await writeJsonAndRead(decoder, { data: { request_id: 1 }, type: "health" }),
      )
      if (healthMessage.type !== "health") {
        throw new ControlPlaneError("workflowd returned an unexpected health response")
      }
      const data = asRecord(healthMessage.data)
      if (data.request_id !== 1) throw new ControlPlaneError("workflowd health response ID mismatch")
      const report = parseHealth(data.report)
      if (report.protocol_version !== this.#expectedProtocolVersion) {
        throw new ControlPlaneError(
          `workflowd protocol ${report.protocol_version} is incompatible with plugin protocol ${this.#expectedProtocolVersion}`,
        )
      }
      return report
    } finally {
      socket.destroy()
    }
  }

  async #exchange(
    requestId: number,
    requestType: string,
    responseType: string,
    data: Readonly<Record<string, unknown>>,
    timeoutMillis = 10_000,
  ): Promise<Record<string, unknown>> {
    const secret = await readSecret(this.#secretPath)
    if (secret === undefined) throw new ControlPlaneError("workflowd credential disappeared")
    const { decoder, socket } = await this.#connect(secret)
    try {
      const message = asRecord(
        await writeJsonAndRead(
          decoder,
          { data: { ...data, request_id: requestId }, type: requestType },
          timeoutMillis,
        ),
      )
      if (message.type === "error") {
        const error = asRecord(message.data)
        throw new ControlPlaneError(
          typeof error.message === "string" ? error.message : "workflowd rejected the request",
        )
      }
      if (message.type !== responseType) {
        throw new ControlPlaneError("workflowd returned an unexpected response")
      }
      const response = asRecord(message.data)
      if (response.request_id !== requestId) {
        throw new ControlPlaneError("workflowd response ID mismatch")
      }
      return response
    } finally {
      socket.destroy()
    }
  }

  async #connect(secret: Buffer): Promise<{ decoder: IpcFrameReader; socket: Socket }> {
    const endpoint = this.#endpoint || namedPipePath(endpointId(secret))
    const { reader: decoder, socket } = await connectIpcSocket(endpoint, {
      errorFactory: (message) => new ControlPlaneError(message),
    })
    try {
      const challengeMessage = asRecord(await readJson(decoder))
      if (challengeMessage.type !== "challenge") {
        throw new ControlPlaneError("workflowd did not send an authentication challenge")
      }
      const challenge = parseChallenge(challengeMessage.data)
      const authenticated = asRecord(
        await writeJsonAndRead(decoder, {
          data: { mac: calculateMac(secret, challenge), nonce: challenge.nonce },
          type: "authenticate",
        }),
      )
      if (authenticated.type !== "authenticated") {
        throw new ControlPlaneError("workflowd did not acknowledge authentication")
      }
      const data = asRecord(authenticated.data)
      if (data.protocol_version !== this.#expectedProtocolVersion) {
        throw new ControlPlaneError("workflowd authentication protocol version mismatch")
      }
      return { decoder, socket }
    } catch (error) {
      socket.destroy()
      throw error
    }
  }
}

async function waitForChildExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout)
    void once(child, "exit").then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export function shutdownCertifiedControlPlane(
  dataDirectory: string,
  ownerToken: string,
  runDigest: string,
): Promise<CertifiedShutdownReceipt> {
  return new LocalControlPlane({ dataDirectory }).shutdownOwned(ownerToken, runDigest)
}

export function resolveDataDirectory(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  const combine = platform === "win32" ? win32.join : posix.join
  if (platform === "win32") {
    return combine(requiredEnvironment(environment, "LOCALAPPDATA"), "OpenCode Cycle")
  }
  if (platform === "linux") {
    const base =
      environment.XDG_DATA_HOME || combine(requiredEnvironment(environment, "HOME"), ".local", "share")
    return combine(base, "opencode-cycle")
  }
  throw new ControlPlaneError(`unsupported native platform ${platform}; supported platforms are linux and win32`)
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]
  if (!value) throw new ControlPlaneError(`required environment variable ${name} is missing`)
  return value
}

export function nativePackageName(platform: NodeJS.Platform, architecture: string): string {
  const target = `${platform}-${architecture}`
  if (!["linux-x64", "win32-x64"].includes(target)) {
    throw new ControlPlaneError(
      `unsupported native platform ${target}; supported targets are linux-x64 and win32-x64`,
    )
  }
  return `@opencode-cycle/native-${target}`
}

function packagedBinaryPath(platform: NodeJS.Platform, architecture: string): string {
  const packageName = nativePackageName(platform, architecture)
  try {
    return require.resolve(packageName)
  } catch (cause) {
    throw new ControlPlaneError(
      `required native package ${packageName} is not installed; reinstall opencode-cycle for this platform`,
      { cause },
    )
  }
}

async function readSecret(path: string): Promise<Buffer | undefined> {
  try {
    const secret = await readFile(path)
    if (secret.length !== 32) throw new ControlPlaneError("workflowd credential has an invalid length")
    return secret
  } catch (error) {
    if (asNodeError(error).code === "ENOENT") return undefined
    throw error
  }
}

function endpointId(secret: Buffer): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 32)
}

function namedPipePath(identifier: string): string {
  return `\\\\.\\pipe\\opencode-cycle-${identifier}`
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length === 0 || payload.length > MAX_IPC_FRAME_BYTES) {
    throw new ControlPlaneError("local IPC frame size is invalid")
  }
  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32BE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

function writeJsonAndRead(
  decoder: IpcFrameReader,
  value: unknown,
  timeoutMillis = 10_000,
): Promise<unknown> {
  return decoder.writeAndRead(encodeFrame(value), timeoutMillis)
}

function readJson(decoder: IpcFrameReader, timeoutMillis = 10_000): Promise<unknown> {
  return decoder.read(timeoutMillis)
}

interface Challenge {
  readonly expires_at_unix_millis: number
  readonly nonce: number[]
}

function parseChallenge(value: unknown): Challenge {
  const challenge = asRecord(value)
  if (
    !Number.isSafeInteger(challenge.expires_at_unix_millis) ||
    !Array.isArray(challenge.nonce) ||
    challenge.nonce.length !== 32 ||
    challenge.nonce.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new ControlPlaneError("workflowd sent a malformed authentication challenge")
  }
  return {
    expires_at_unix_millis: challenge.expires_at_unix_millis as number,
    nonce: challenge.nonce as number[],
  }
}

function calculateMac(secret: Buffer, challenge: Challenge): number[] {
  const expiry = Buffer.allocUnsafe(8)
  expiry.writeBigInt64BE(BigInt(challenge.expires_at_unix_millis))
  return Array.from(
    createHmac("sha256", secret)
      .update(AUTH_DOMAIN)
      .update(Buffer.from(challenge.nonce))
      .update(expiry)
      .digest(),
  )
}

function parseHealth(value: unknown): ControlPlaneHealth {
  const report = asRecord(value)
  if (
    typeof report.product_version !== "string" ||
    !Number.isInteger(report.protocol_version) ||
    !Number.isInteger(report.schema_version) ||
    (report.schema_mode !== "read_write" && report.schema_mode !== "safe_read_only")
  ) {
    throw new ControlPlaneError("workflowd returned a malformed health report")
  }
  return report as unknown as ControlPlaneHealth
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneError("workflowd returned a malformed message")
  }
  return value as Record<string, unknown>
}

function asNodeError(value: unknown): NodeJS.ErrnoException {
  return value as NodeJS.ErrnoException
}

const SHA256 = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function validateTaskClosureReport(
  projectKey: string,
  workflowId: string,
  report: TaskClosureReportInput,
): void {
  const revision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
  if (
    !projectKey ||
    Buffer.byteLength(projectKey) > 32_768 ||
    !UUID.test(workflowId) ||
    !UUID.test(report.task_id) ||
    !UUID.test(report.receipt_id) ||
    !SHA256.test(report.architecture_digest) ||
    !SHA256.test(report.request_digest) ||
    !revision.test(report.base_revision) ||
    !revision.test(report.submitted_revision) ||
    report.reviewer.verdict.task_id !== report.task_id ||
    report.reviewer.verdict.revision !== report.submitted_revision ||
    !SHA256.test(report.reviewer.verdict_digest)
  ) {
    throw new ControlPlaneError("task closure identity or revision binding is invalid")
  }
  if (
    report.commands.length === 0 ||
    report.commands.length > 256 ||
    report.commands.some(
      (command) =>
        !UUID.test(command.evidence_id) ||
        !SHA256.test(command.output_digest) ||
        !Number.isSafeInteger(command.exit_code) ||
        !command.invocation ||
        Buffer.byteLength(command.invocation) > 4_096,
    ) ||
    new Set(report.commands.map((command) => command.evidence_id)).size !== report.commands.length
  ) {
    throw new ControlPlaneError("task closure deterministic evidence is invalid")
  }
  if (
    report.changed_paths.length > 4_096 ||
    report.changed_paths.some(
      (path) => !path || Buffer.byteLength(path) > 4_096 || path.includes("\0"),
    ) ||
    new Set(report.changed_paths).size !== report.changed_paths.length
  ) {
    throw new ControlPlaneError("task closure changed-path evidence is invalid")
  }
}

function parseCandidateManifest(value: unknown): CandidateManifestInput {
  const manifest = asRecord(value)
  const digestFields = [
    manifest.configuration_digest,
    manifest.dependency_state_digest,
    manifest.diff_digest,
    manifest.environment_digest,
  ]
  if (
    typeof manifest.candidate_id !== "string" ||
    !UUID.test(manifest.candidate_id) ||
    (manifest.base_revision !== null && typeof manifest.base_revision !== "string") ||
    digestFields.some((digest) => typeof digest !== "string" || !SHA256.test(digest)) ||
    !Array.isArray(manifest.evidence_ids) ||
    manifest.evidence_ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    !Array.isArray(manifest.files)
  ) {
    throw new ControlPlaneError("workflowd returned a malformed candidate manifest")
  }
  const files = manifest.files.map((value) => {
    const file = asRecord(value)
    if (
      typeof file.path !== "string" ||
      !file.path ||
      (file.digest !== null && (typeof file.digest !== "string" || !SHA256.test(file.digest))) ||
      !["added", "deleted", "generated", "modified"].includes(String(file.kind))
    ) {
      throw new ControlPlaneError("workflowd returned a malformed candidate file")
    }
    return file as unknown as CandidateManifestInput["files"][number]
  })
  return { ...manifest, files } as unknown as CandidateManifestInput
}

function parseEvidenceRecord(value: unknown): EvidenceRecordInput {
  const record = asRecord(value)
  if (
    typeof record.id !== "string" ||
    !UUID.test(record.id) ||
    typeof record.candidate_digest !== "string" ||
    !SHA256.test(record.candidate_digest) ||
    typeof record.output_digest !== "string" ||
    !SHA256.test(record.output_digest) ||
    typeof record.invocation !== "string" ||
    typeof record.tool !== "string" ||
    typeof record.tool_version !== "string" ||
    typeof record.started_at !== "string" ||
    typeof record.finished_at !== "string" ||
    !["failed", "passed", "skipped"].includes(String(record.status)) ||
    ![
      "browser",
      "build",
      "command",
      "database",
      "inspection",
      "lint",
      "package",
      "security",
      "test",
    ].includes(String(record.kind))
  ) {
    throw new ControlPlaneError("workflowd returned a malformed evidence record")
  }
  return record as unknown as EvidenceRecordInput
}

function parseArbitrationReceipt(value: unknown): ArbitrationReceiptInput {
  const receipt = asRecord(value)
  const requiredDigests = [
    receipt.arbiter_verdict_digest,
    receipt.candidate_digest,
    receipt.request_digest,
  ]
  const optionalDigests = [receipt.functional_review_digest, receipt.security_review_digest]
  if (
    typeof receipt.id !== "string" ||
    !UUID.test(receipt.id) ||
    typeof receipt.workflow_id !== "string" ||
    !UUID.test(receipt.workflow_id) ||
    typeof receipt.candidate_id !== "string" ||
    !UUID.test(receipt.candidate_id) ||
    typeof receipt.finalized_at !== "string" ||
    requiredDigests.some((digest) => typeof digest !== "string" || !SHA256.test(digest)) ||
    optionalDigests.some(
      (digest) => digest !== null && (typeof digest !== "string" || !SHA256.test(digest)),
    ) ||
    !Array.isArray(receipt.evidence_ids) ||
    receipt.evidence_ids.some((id) => typeof id !== "string" || !UUID.test(id))
  ) {
    throw new ControlPlaneError("workflowd returned a malformed arbitration receipt")
  }
  return receipt as unknown as ArbitrationReceiptInput
}
