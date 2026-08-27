import { isAbsolute } from "node:path"

import type { HostClient } from "../host.js"

import type { RoleModels, RoleVariants } from "../agent.js"
import { digest, observation } from "../audit-events.js"
import type {
  ArchitecturePlanInput,
  CandidateManifestInput,
  ManagedBrowserAttestationInput,
  VerificationReceipt,
} from "../client.js"
import type { LocalControlPlane } from "../control-plane.js"
import type { WorkflowRole } from "../permissions.js"
import { runArbiter } from "./arbiter.js"
import { runIndependentReviews, type ReviewVerdictInput } from "./reviewers.js"

interface RetryRecoveryInput {
  readonly active: boolean
  readonly activeModel: string | null
  readonly activeVariant?: string | null
  readonly browserAttestations: (
    sessionIds: readonly string[],
    candidateDigest: string,
  ) => Promise<readonly ManagedBrowserAttestationInput[]>
  readonly models: RoleModels
  readonly parentSessionId: string
  readonly projectDirectory: string
  readonly projectKey: string
  readonly registerSession: (sessionId: string, role: WorkflowRole) => void
  readonly result: unknown
  readonly resumeEarlyStage?: (context: EarlyRecoveryContext) => Promise<{ readonly state: string }>
  readonly signal?: AbortSignal
  readonly variants?: RoleVariants
}

type RecoveryControlPlane = Pick<
  LocalControlPlane,
  | "audit"
  | "control"
  | "promoteCandidate"
  | "submitArbitration"
  | "submitReview"
  | "verifyCandidate"
>

interface RecoveryContext {
  readonly candidateDigest: string
  readonly candidateId: string
  readonly evidence: VerificationReceipt["evidence"]
  readonly executorSessionIds: readonly string[]
  readonly manifest: CandidateManifestInput
  readonly mode: "full" | "quick"
  readonly originalRequest: string
  readonly plan: ArchitecturePlanInput
  readonly reviews: readonly ReviewVerdictInput[]
  readonly state: "arbitration" | "delivery" | "independent_reviews" | "verification"
  readonly verificationPlanId: string
  readonly workflowId: string
  readonly worktreePath: string
}

export interface EarlyRecoveryContext {
  readonly baseRevision?: string
  readonly mode: "full" | "quick"
  readonly originalRequest: string
  readonly plan?: ArchitecturePlanInput
  readonly repairFeedback?: string
  readonly requestDigest: string
  readonly state: "architecture" | "execution" | "quick_execution"
  readonly workflowId: string
  readonly worktreePath: string
}

export async function recoverWorkflowRetry(
  client: HostClient,
  controlPlane: RecoveryControlPlane,
  input: RetryRecoveryInput,
): Promise<unknown> {
  input.signal?.throwIfAborted()
  if (input.active) return input.result
  const result = record(input.result, "retry response")
  const workflowId = requiredString(result.workflowId, "retry response has no workflow identifier")
  const status = record(
    await controlPlane.control(input.projectKey, "status", workflowId),
    "workflow status",
  )
  if (status.state === "completed") return { ...result, state: "completed" }
  if (
    status.state === "architecture" ||
    status.state === "execution" ||
    status.state === "quick_execution"
  ) {
    if (input.resumeEarlyStage === undefined) {
      throw new Error("retry recovery cannot resume an early workflow stage")
    }
    const context = parseEarlyRecoveryContext(
      await controlPlane.control(input.projectKey, "recovery", workflowId),
      workflowId,
      status.state,
    )
    input.signal?.throwIfAborted()
    const resumed = await input.resumeEarlyStage(context)
    input.signal?.throwIfAborted()
    if (typeof resumed.state !== "string" || resumed.state.length === 0) {
      throw new Error("early retry recovery returned an invalid workflow state")
    }
    return { ...result, state: resumed.state }
  }
  if (!isRecoverableState(status.state)) return input.result
  if (status.state === "delivery") {
    return deliver(controlPlane, input, result, workflowId, requiredString(status.currentCandidate, "retry recovery requires an approved candidate"))
  }

  const recovery = parseRecoveryContext(
    await controlPlane.control(input.projectKey, "recovery", workflowId),
    workflowId,
    status.state,
  )
  let state = recovery.state
  let evidence = recovery.evidence
  let reviews = recovery.reviews

  if (state === "verification") {
    const verification = await controlPlane.verifyCandidate(
      input.projectKey,
      workflowId,
      recovery.candidateId,
      recovery.verificationPlanId,
      await input.browserAttestations(recovery.executorSessionIds, recovery.candidateDigest),
    )
    await controlPlane.audit(
      observation(
        {
          candidateID: recovery.candidateId,
          projectKey: input.projectKey,
          workflowID: workflowId,
        },
        {
          gate: "mandatory_verification_recovery",
          status: verification.mandatoryPassed ? "passed" : "failed",
          type: "verification",
        },
        { evidence_digest: digest(verification.evidence), workflow_state: verification.workflowState },
      ),
    )
    evidence = verification.evidence
    if (!verification.mandatoryPassed || !isRecoverableState(verification.workflowState)) {
      return { ...result, state: verification.workflowState }
    }
    state = verification.workflowState
  }

  if (state === "independent_reviews") {
    const completed = await runIndependentReviews(client, {
      candidate: recovery.manifest,
      candidateDigest: recovery.candidateDigest,
      directory: recovery.worktreePath,
      evidence,
      models: reviewerModels(input.models, input.activeModel),
      onSessionCreated: input.registerSession,
      originalRequest: recovery.originalRequest,
      parentSessionId: input.parentSessionId,
      plan: recovery.plan,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      variants: reviewerVariants(input),
    })
    input.signal?.throwIfAborted()
    for (const review of completed) {
      await controlPlane.submitReview(
        input.projectKey,
        workflowId,
        recovery.candidateId,
        review.verdict,
      )
      await controlPlane.audit(
        observation(
          {
            candidateID: recovery.candidateId,
            projectKey: input.projectKey,
            role: review.role,
            sessionID: review.sessionId,
            workflowID: workflowId,
          },
          { action: "independent_review_recovered", type: "workflow" },
          { verdict_digest: digest(review.verdict) },
        ),
      )
    }
    reviews = completed.map((review) => review.verdict)
    state = "arbitration"
  }

  if (state !== "arbitration") return { ...result, state }
  const arbiterVariant = roleVariant(input, "arbiter")
  const arbitration = await runArbiter(client, {
    candidate: recovery.manifest,
    candidateDigest: recovery.candidateDigest,
    directory: recovery.worktreePath,
    evidence,
    model: input.models.arbiter ?? input.activeModel,
    mode: recovery.mode,
    onSessionCreated: (sessionId) => input.registerSession(sessionId, "arbiter"),
    originalRequest: recovery.originalRequest,
    parentSessionId: input.parentSessionId,
    plan: recovery.plan,
    reviews,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(arbiterVariant === undefined ? {} : { variant: arbiterVariant }),
  })
  input.signal?.throwIfAborted()
  const arbitrationResult = await controlPlane.submitArbitration(
    input.projectKey,
    workflowId,
    recovery.candidateId,
    arbitration.verdict,
  )
  await controlPlane.audit(
    observation(
      {
        candidateID: recovery.candidateId,
        projectKey: input.projectKey,
        role: "arbiter",
        sessionID: arbitration.sessionId,
        workflowID: workflowId,
      },
      { action: `arbitration_recovery_${arbitrationResult.decision}`, type: "workflow" },
      {
        receipt_digest: arbitrationResult.receiptDigest,
        workflow_state: arbitrationResult.workflowState,
      },
    ),
  )
  if (arbitrationResult.decision !== "approved" || arbitrationResult.workflowState !== "delivery") {
    return { ...result, state: arbitrationResult.workflowState }
  }
  return deliver(controlPlane, input, result, workflowId, recovery.candidateId)
}

function parseEarlyRecoveryContext(
  value: unknown,
  workflowId: string,
  expectedState: "architecture" | "execution" | "quick_execution",
): EarlyRecoveryContext {
  const context = record(value, "early retry recovery context")
  const baseRevision = context.baseRevision
  const plan = context.plan
  const repairFeedback = context.repairFeedback
  if (
    context.workflowId !== workflowId ||
    context.state !== expectedState ||
    (context.mode !== "full" && context.mode !== "quick") ||
    (expectedState === "architecture" && context.mode !== "full") ||
    (expectedState === "quick_execution" && context.mode !== "quick") ||
    typeof context.originalRequest !== "string" ||
    context.originalRequest.length === 0 ||
    typeof context.requestDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(context.requestDigest) ||
    typeof context.worktreePath !== "string" ||
    !isAbsolute(context.worktreePath) ||
    (baseRevision !== undefined &&
      (typeof baseRevision !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseRevision))) ||
    (repairFeedback !== undefined &&
      (typeof repairFeedback !== "string" || repairFeedback.length > 64 * 1024)) ||
    (expectedState !== "architecture" &&
      plan !== undefined &&
      (typeof plan !== "object" || plan === null || Array.isArray(plan))) ||
    (expectedState === "architecture" && plan !== undefined)
  ) {
    throw new Error("early retry recovery context is malformed")
  }
  return context as unknown as EarlyRecoveryContext
}

async function deliver(
  controlPlane: RecoveryControlPlane,
  input: RetryRecoveryInput,
  result: Readonly<Record<string, unknown>>,
  workflowId: string,
  candidateId: string,
): Promise<unknown> {
  input.signal?.throwIfAborted()
  const recovery = await controlPlane.promoteCandidate(
    input.projectKey,
    workflowId,
    candidateId,
    input.projectDirectory,
  )
  return { ...result, recovery, state: recovery.workflowState }
}

function parseRecoveryContext(value: unknown, workflowId: string, expectedState: unknown): RecoveryContext {
  const context = record(value, "retry recovery context")
  if (
    context.workflowId !== workflowId ||
    context.state !== expectedState ||
    !isRecoverableState(context.state) ||
    (context.mode !== "full" && context.mode !== "quick") ||
    typeof context.candidateDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(context.candidateDigest) ||
    typeof context.candidateId !== "string" ||
    typeof context.verificationPlanId !== "string" ||
    typeof context.originalRequest !== "string" ||
    !context.originalRequest ||
    typeof context.worktreePath !== "string" ||
    !isAbsolute(context.worktreePath) ||
    !Array.isArray(context.executorSessionIds) ||
    context.executorSessionIds.some((sessionId) => typeof sessionId !== "string" || !sessionId) ||
    !Array.isArray(context.evidence) ||
    !Array.isArray(context.reviews) ||
    typeof context.manifest !== "object" ||
    context.manifest === null ||
    typeof context.plan !== "object" ||
    context.plan === null
  ) {
    throw new Error("retry recovery context is malformed")
  }
  return context as unknown as RecoveryContext
}

function isRecoverableState(value: unknown): value is RecoveryContext["state"] {
  return ["arbitration", "delivery", "independent_reviews", "verification"].includes(String(value))
}

function reviewerModels(
  models: RoleModels,
  inherited: string | null,
): Partial<Record<"functional_reviewer" | "security_reviewer", string>> {
  const result: Partial<Record<"functional_reviewer" | "security_reviewer", string>> = {}
  const functional = models.functional_reviewer ?? inherited
  const security = models.security_reviewer ?? inherited
  if (functional !== null && functional !== undefined) result.functional_reviewer = functional
  if (security !== null && security !== undefined) result.security_reviewer = security
  return result
}

function reviewerVariants(
  input: Pick<RetryRecoveryInput, "activeVariant" | "models" | "variants">,
): Partial<Record<"functional_reviewer" | "security_reviewer", string>> {
  const result: Partial<Record<"functional_reviewer" | "security_reviewer", string>> = {}
  const functional = roleVariant(input, "functional_reviewer")
  const security = roleVariant(input, "security_reviewer")
  if (functional !== undefined) result.functional_reviewer = functional
  if (security !== undefined) result.security_reviewer = security
  return result
}

function roleVariant(
  input: Pick<RetryRecoveryInput, "activeVariant" | "models" | "variants">,
  role: WorkflowRole,
): string | undefined {
  return input.models[role] === undefined
    ? (input.activeVariant ?? undefined)
    : input.variants?.[role]
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} is malformed`)
  }
  return value as Readonly<Record<string, unknown>>
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message)
  return value
}
