import type { HostClient } from "../host.js"
import { randomUUID } from "node:crypto"

import type { RoleModels, RoleVariants } from "../agent.js"
import { digest, observation } from "../audit-events.js"
import type { ManagedBrowserAttestationInput } from "../client.js"
import { LocalControlPlane } from "../control-plane.js"
import type { WorkflowRole } from "../permissions.js"
import { runArbiter, type ArbiterVerdictInput } from "./arbiter.js"
import { ArchitectOutputError, runArchitect } from "./architect.js"
import { assertGitRepository } from "../git-repository.js"
import { runExecutionPlan, type SubmittedTaskExecutionResult, type TaskExecutionResult } from "./executor.js"
import { runIndependentReviews, type ReviewVerdictInput } from "./reviewers.js"
import { runTaskReview } from "./task-review.js"
import { runTaskVerification } from "./task-verification.js"

interface FullWorkflowInput {
  readonly activeModel: string | null
  readonly activeVariant: string | null
  readonly browserAttestations: (
    sessionIds: readonly string[],
    candidateDigest: string,
  ) => Promise<readonly ManagedBrowserAttestationInput[]>
  readonly codeContext?: unknown
  readonly initialPlan?: Awaited<ReturnType<typeof runArchitect>>["plan"]
  readonly initialWorktree?: Awaited<ReturnType<LocalControlPlane["prepareWorktree"]>>
  readonly models: RoleModels
  readonly mode: "full" | "quick"
  readonly originalRequest: string
  readonly parentSessionId: string
  readonly projectKey: string
  readonly registerSession: (sessionId: string, role: WorkflowRole) => void
  readonly requestDigest: string
  readonly repairFeedback?: string
  readonly signal?: AbortSignal
  readonly sourceDirectory: string
  readonly variants: RoleVariants
  readonly workflowId: string
}

export interface FullWorkflowResult {
  readonly state: string
}

export async function runFullWorkflow(
  client: HostClient,
  controlPlane: LocalControlPlane,
  input: FullWorkflowInput,
): Promise<FullWorkflowResult> {
  await assertGitRepository(input.sourceDirectory)
  let plan = input.initialPlan
  let worktree = input.initialWorktree
  let repairFeedback = input.repairFeedback
  let architectureAttempts = 0

  for (;;) {
    await waitForRunnable(controlPlane, input)
    if (plan === undefined) {
      architectureAttempts += 1
      if (architectureAttempts > 5) {
        return { state: await controlPlane.reportExecution(input.projectKey, input.workflowId, "blocked") }
      }
      let architecture: Awaited<ReturnType<typeof runArchitect>>
      const architectVariant = roleVariant(input, "architect")
      try {
        architecture = await runArchitect(client, {
          codeContext: input.codeContext,
          directory: worktree?.path ?? input.sourceDirectory,
          model: input.models.architect ?? input.activeModel,
          onSessionCreated: (sessionId) => input.registerSession(sessionId, "architect"),
          originalRequest: input.originalRequest,
          parentSessionId: input.parentSessionId,
          ...(repairFeedback === undefined ? {} : { repairFeedback }),
          requestDigest: input.requestDigest,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(architectVariant === undefined ? {} : { variant: architectVariant }),
        })
      } catch (error) {
        if (!(error instanceof ArchitectOutputError)) throw error
        repairFeedback = `The previous architecture response was invalid: ${error.message}`
        continue
      }
      await waitForRunnable(controlPlane, input)
      plan = architecture.plan
      await controlPlane.submitArchitecture(input.projectKey, input.workflowId, plan)
      await controlPlane.audit(
        observation(
          {
            projectKey: input.projectKey,
            role: "architect",
            sessionID: architecture.sessionId,
            workflowID: input.workflowId,
          },
          { action: "architecture_accepted", type: "workflow" },
          { plan_digest: digest(plan), request_digest: input.requestDigest },
        ),
      )
    }

    if (worktree === undefined) {
      worktree = await controlPlane.prepareWorktree(
        input.projectKey,
        input.sourceDirectory,
        input.workflowId,
      )
      await controlPlane.audit(
        observation(
          { projectKey: input.projectKey, workflowID: input.workflowId },
          { externally_attributed: false, revision: worktree.baseRevision, type: "git" },
          { action: "execution_worktree_prepared" },
        ),
      )
    }

    await waitForRunnable(controlPlane, input)
    const executorVariant = roleVariant(input, "executor")
    const activePlan = plan
    const activeWorktree = worktree
    const executions = await runExecutionPlan(client, {
      directory: activeWorktree.path,
      finalizeTask: (task, result) =>
        finalizeSubmittedTask(client, controlPlane, input, activeWorktree.path, activePlan, task, result),
      model: input.models.executor ?? input.activeModel,
      onSessionCreated: (sessionId) => input.registerSession(sessionId, "executor"),
      originalRequest: input.originalRequest,
      parentSessionId: input.parentSessionId,
      plan,
      ...(repairFeedback === undefined ? {} : { repairFeedback }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(executorVariant === undefined ? {} : { variant: executorVariant }),
    })
    await waitForRunnable(controlPlane, input)
    for (const execution of executions) {
      await controlPlane.audit(
        observation(
          {
            files: execution.changedPaths,
            projectKey: input.projectKey,
            role: "executor",
            sessionID: execution.sessionId,
            taskID: execution.taskId,
            workflowID: input.workflowId,
          },
          { action: `execution_task_${execution.status}`, type: "workflow" },
          { revision: execution.revision, summary_digest: digest(execution.summary) },
        ),
      )
    }
    if (
      executions.length !== plan.tasks.length ||
      executions.some((execution) => execution.status !== "completed")
    ) {
      const last = executions.at(-1)
      repairFeedback = last?.summary ?? "Executor did not complete every planned task."
      if (last?.status === "plan_defect") {
        const state = await controlPlane.reportExecution(
          input.projectKey,
          input.workflowId,
          "plan_defect",
        )
        if (state !== "architecture") return { state }
        plan = undefined
        continue
      }
      if (last?.status === "review_rejected" || last?.status === "verification_failed") {
        repairFeedback = last.summary
        continue
      }
      return {
        state: await controlPlane.reportExecution(input.projectKey, input.workflowId, "blocked"),
      }
    }

    await waitForRunnable(controlPlane, input)
    const verificationPlan = await controlPlane.planVerification(
      input.projectKey,
      input.workflowId,
    )
    const candidate = await controlPlane.freezeCandidate(
      input.projectKey,
      input.workflowId,
      worktree.baseRevision,
      verificationPlan.planId,
      verificationPlan.evidenceIds,
    )
    await controlPlane.audit(
      observation(
        {
          candidateID: candidate.candidateId,
          files: candidate.manifest.files.map((file) => file.path),
          projectKey: input.projectKey,
          workflowID: input.workflowId,
        },
        { action: "candidate_ready_for_verification", type: "workflow" },
        { candidate_digest: candidate.candidateDigest, candidate_id: candidate.candidateId },
      ),
    )
    const verification = await controlPlane.verifyCandidate(
      input.projectKey,
      input.workflowId,
      candidate.candidateId,
      verificationPlan.planId,
      await input.browserAttestations(
        executions.map((execution) => execution.sessionId),
        candidate.candidateDigest,
      ),
    )
    await controlPlane.audit(
      observation(
        {
          candidateID: candidate.candidateId,
          projectKey: input.projectKey,
          workflowID: input.workflowId,
        },
        {
          gate: "mandatory_verification",
          status: verification.mandatoryPassed ? "passed" : "failed",
          type: "verification",
        },
        {
          evidence_digest: digest(verification.evidence),
          workflow_state: verification.workflowState,
        },
      ),
    )
    if (!verification.mandatoryPassed) {
      if (verification.workflowState === "execution") {
        repairFeedback = JSON.stringify(
          verification.evidence.filter((evidence) => evidence.record.status !== "passed"),
        )
        continue
      }
      return { state: verification.workflowState }
    }
    const expectedPostVerificationState =
      input.mode === "full" ? "independent_reviews" : "arbitration"
    if (verification.workflowState !== expectedPostVerificationState) {
      return { state: verification.workflowState }
    }

    let reviews: readonly Awaited<ReturnType<typeof runIndependentReviews>>[number][] = []
    if (input.mode === "full") {
      reviews = await runIndependentReviews(client, {
        candidate: candidate.manifest,
        candidateDigest: candidate.candidateDigest,
        directory: worktree.path,
        evidence: verification.evidence,
        models: reviewerModels(input.models, input.activeModel),
        onSessionCreated: input.registerSession,
        originalRequest: input.originalRequest,
        parentSessionId: input.parentSessionId,
        plan,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        variants: reviewerVariants(input),
      })
      await waitForRunnable(controlPlane, input)
    }
    for (const review of reviews) {
      await controlPlane.submitReview(
        input.projectKey,
        input.workflowId,
        candidate.candidateId,
        review.verdict,
      )
      await controlPlane.audit(
        observation(
          {
            candidateID: candidate.candidateId,
            projectKey: input.projectKey,
            role: review.role,
            sessionID: review.sessionId,
            workflowID: input.workflowId,
          },
          { action: "independent_review_submitted", type: "workflow" },
          { verdict_digest: digest(review.verdict) },
        ),
      )
    }

    const arbiterVariant = roleVariant(input, "arbiter")
    const arbitration = await runArbiter(client, {
      candidate: candidate.manifest,
      candidateDigest: candidate.candidateDigest,
      directory: worktree.path,
      evidence: verification.evidence,
      model: input.models.arbiter ?? input.activeModel,
      mode: input.mode,
      onSessionCreated: (sessionId) => input.registerSession(sessionId, "arbiter"),
      originalRequest: input.originalRequest,
      parentSessionId: input.parentSessionId,
      plan,
      reviews: reviews.map((review) => review.verdict),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(arbiterVariant === undefined ? {} : { variant: arbiterVariant }),
    })
    await waitForRunnable(controlPlane, input)
    const result = await controlPlane.submitArbitration(
      input.projectKey,
      input.workflowId,
      candidate.candidateId,
      arbitration.verdict,
    )
    await controlPlane.audit(
      observation(
        {
          candidateID: candidate.candidateId,
          projectKey: input.projectKey,
          role: "arbiter",
          sessionID: arbitration.sessionId,
          workflowID: input.workflowId,
        },
        { action: `arbitration_${result.decision}`, type: "workflow" },
        { receipt_digest: result.receiptDigest, workflow_state: result.workflowState },
      ),
    )
    // The plane decides where the run goes; the verdict only says what the arbiter wrote. An
    // approval that contradicts a reviewer's rejection is recorded and routed to repair, so a
    // branch keyed on the decision would end the run at execution with the repair never driven
    // and nothing saying why.
    if (result.workflowState === "delivery") {
      const promotion = await controlPlane.promoteCandidate(
        input.projectKey,
        input.workflowId,
        candidate.candidateId,
        input.sourceDirectory,
      )
      await controlPlane.audit(
        observation(
          {
            candidateID: candidate.candidateId,
            files: promotion.changedPaths,
            projectKey: input.projectKey,
            workflowID: input.workflowId,
          },
          { externally_attributed: false, revision: worktree.baseRevision, type: "git" },
          { action: "approved_candidate_delivered", workflow_state: promotion.workflowState },
        ),
      )
      return { state: promotion.workflowState }
    }
    if (result.workflowState === "blocked") {
      return { state: result.workflowState }
    }
    repairFeedback = repairFeedbackFor(
      reviews.map((review) => review.verdict),
      arbitration.verdict,
    )
    if (result.workflowState === "architecture") plan = undefined
    else if (result.workflowState !== "execution") return { state: result.workflowState }
  }
}

/**
 * What the repair has to answer: the findings of every review that rejected, and the arbiter's own
 * only when the arbiter rejected.
 *
 * An approval asked for nothing to be fixed, and after a reviewer's rejection binds, the verdict on
 * record is an approval with no findings at all. Sending that alone put the executor back to work
 * against an objection it had to rediscover — the reviewer had already written down exactly what
 * was wrong.
 *
 * The verdict is still the fallback when nothing carries a finding, so this never sends less than
 * it did before.
 */
function repairFeedbackFor(
  reviews: readonly ReviewVerdictInput[],
  verdict: ArbiterVerdictInput,
): string {
  const refusals: { readonly findings: unknown; readonly from: string }[] = reviews
    .filter((review) => review.decision === "rejected")
    .map((review) => ({ findings: review.findings, from: review.role }))
  if (verdict.decision === "rejected") {
    refusals.push({ findings: verdict.findings, from: "arbiter" })
  }
  const carrying = refusals.filter(
    (refusal) => Array.isArray(refusal.findings) && refusal.findings.length > 0,
  )
  return JSON.stringify(carrying.length > 0 ? carrying : verdict)
}

async function finalizeSubmittedTask(
  client: HostClient,
  controlPlane: LocalControlPlane,
  input: FullWorkflowInput,
  directory: string,
  plan: Awaited<ReturnType<typeof runArchitect>>["plan"],
  task: Awaited<ReturnType<typeof runArchitect>>["plan"]["tasks"][number],
  result: SubmittedTaskExecutionResult,
): Promise<TaskExecutionResult> {
  const verification = await runTaskVerification({
    baseRevision: result.baseRevision,
    changedPaths: result.changedPaths,
    directory,
    revision: result.revision,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    task,
    verificationHostPath: await controlPlane.nativeBinaryPath(),
  })
  await controlPlane.audit(
    observation(
      {
        files: result.changedPaths,
        projectKey: input.projectKey,
        role: "executor",
        sessionID: result.sessionId,
        taskID: result.taskId,
        workflowID: input.workflowId,
      },
      {
        gate: "task_verification",
        status: verification.passed ? "passed" : "failed",
        type: "verification",
      },
      { revision: result.revision, verification_digest: digest(verification) },
    ),
  )
  if (!verification.passed) {
    return {
      ...result,
      status: "verification_failed",
      summary: `Deterministic task verification failed: ${
        verification.bindingError ??
        (verification.commands
          .filter((command) => command.status !== "passed")
          .map((command) => `${command.invocation}=${command.status}`)
          .join(", ") || "incomplete verification evidence")
      }`,
    }
  }
  const reviewerVariant = roleVariant(input, "functional_reviewer")
  let review: Awaited<ReturnType<typeof runTaskReview>>
  try {
    review = await runTaskReview(client, {
      baseRevision: result.baseRevision,
      changedPaths: result.changedPaths,
      directory,
      model: input.models.functional_reviewer ?? input.activeModel,
      onSessionCreated: (sessionId) => input.registerSession(sessionId, "functional_reviewer"),
      originalRequest: input.originalRequest,
      parentSessionId: input.parentSessionId,
      plan,
      revision: result.revision,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      task,
      ...(reviewerVariant === undefined ? {} : { variant: reviewerVariant }),
      verification,
    })
  } catch (error) {
    input.signal?.throwIfAborted()
    return {
      ...result,
      status: "review_rejected",
      summary: `Independent task review was unavailable or invalid: ${boundedError(error)}`,
    }
  }
  await controlPlane.audit(
    observation(
      {
        files: result.changedPaths,
        projectKey: input.projectKey,
        role: "functional_reviewer",
        sessionID: review.sessionId,
        taskID: result.taskId,
        workflowID: input.workflowId,
      },
      { action: `task_review_${review.verdict.decision}`, type: "workflow" },
      { revision: result.revision, verdict_digest: digest(review.verdict) },
    ),
  )
  if (review.verdict.decision !== "approved") {
    return {
      ...result,
      status: review.verdict.repair_target === "architecture" ? "plan_defect" : "review_rejected",
      summary: `Independent task review rejected ${task.id}: ${review.verdict.findings
        .map((finding) => finding.summary)
        .join("; ") || "requirements unsatisfied"}`,
    }
  }
  await controlPlane.reportTaskClosure(input.projectKey, input.workflowId, {
    architecture_digest: digest(plan),
    base_revision: result.baseRevision,
    changed_paths: result.changedPaths,
    commands: verification.commands.map((command) => ({
      evidence_id: command.id,
      exit_code: command.exitCode ?? -1,
      invocation: command.invocation,
      output_digest: command.outputDigest,
      status: command.status,
    })),
    receipt_id: randomUUID(),
    request_digest: input.requestDigest,
    reviewer: {
      verdict: review.verdict,
      verdict_digest: digest(review.verdict),
    },
    submitted_revision: result.revision,
    task_id: result.taskId,
  })
  return { ...result, status: "completed" }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 1_024)
}

async function waitForRunnable(
  controlPlane: LocalControlPlane,
  input: Pick<FullWorkflowInput, "projectKey" | "signal" | "workflowId">,
): Promise<void> {
  for (;;) {
    input.signal?.throwIfAborted()
    const status = await controlPlane.control(input.projectKey, "status", input.workflowId)
    if (typeof status !== "object" || status === null || !("state" in status)) {
      throw new Error("workflowd returned an invalid workflow status")
    }
    const state = (status as { state: unknown }).state
    if (state === "paused") {
      await delay(250, input.signal)
      continue
    }
    if (state === "cancelled" || state === "blocked") {
      throw new Error(`Workflow stopped in ${state} state`)
    }
    return
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    signal?.addEventListener("abort", aborted, { once: true })

    function done() {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }

    function aborted() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
  })
}

function reviewerModels(
  roleModels: RoleModels,
  inheritedModel: string | null,
): Partial<Record<"functional_reviewer" | "security_reviewer", string>> {
  const models: Partial<Record<"functional_reviewer" | "security_reviewer", string>> = {}
  const functional = roleModels.functional_reviewer ?? inheritedModel
  const security = roleModels.security_reviewer ?? inheritedModel
  if (functional !== null && functional !== undefined) models.functional_reviewer = functional
  if (security !== null && security !== undefined) models.security_reviewer = security
  return models
}

function reviewerVariants(
  input: Pick<FullWorkflowInput, "activeVariant" | "models" | "variants">,
): Partial<Record<"functional_reviewer" | "security_reviewer", string>> {
  const variants: Partial<Record<"functional_reviewer" | "security_reviewer", string>> = {}
  const functional = roleVariant(input, "functional_reviewer")
  const security = roleVariant(input, "security_reviewer")
  if (functional !== undefined) variants.functional_reviewer = functional
  if (security !== undefined) variants.security_reviewer = security
  return variants
}

function roleVariant(
  input: Pick<FullWorkflowInput, "activeVariant" | "models" | "variants">,
  role: WorkflowRole,
): string | undefined {
  return input.models[role] === undefined ? (input.activeVariant ?? undefined) : input.variants[role]
}
