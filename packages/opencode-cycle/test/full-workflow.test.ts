import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runFullWorkflow } from "../src/orchestration/full-workflow.js"

for (const mode of ["full", "quick"] as const) {
  test(`${mode} workflow automatically repairs a rejected candidate and reruns required gates`, async () => {
  const repository = await createRepository()
  const baseRevision = await git(repository, ["rev-parse", "HEAD"])
  let evidenceId = crypto.randomUUID()
  let executorRuns = 0
  let arbiterRuns = 0
  let architectureRuns = 0
  let taskReviewRuns = 0
  const architectPrompts: string[] = []
  let statusCalls = 0
  const executorPrompts: string[] = []
  const sessions: string[] = []
  const verificationAttestations: unknown[] = []
  const launchedModels = new Map<string, { modelID: string; providerID: string }>()
  const launchedVariants = new Map<string, string>()
  const controller = new AbortController()
  const childSignals: (AbortSignal | undefined)[] = []
  const client = {
    session: {
      async create(options: { body: { title: string }; signal?: AbortSignal }) {
        childSignals.push(options.signal)
        return { data: { id: `${options.body.title}-${crypto.randomUUID()}` } }
      },
      async prompt(options: {
        body: {
          agent: string
          model?: { modelID: string; providerID: string }
          parts: { text: string }[]
          variant?: string
        }
        query: { directory: string }
        signal?: AbortSignal
      }) {
        childSignals.push(options.signal)
        if (options.body.model !== undefined) launchedModels.set(options.body.agent, options.body.model)
        if (options.body.variant !== undefined) launchedVariants.set(options.body.agent, options.body.variant)
        const prompt = options.body.parts[0]?.text ?? ""
        if (options.body.agent === "Cycle Architect") {
          architectureRuns += 1
          architectPrompts.push(prompt)
          return response({
            assumptions: [],
            integration_checks: ["Run integration verification."],
            requirements: [
              {
                acceptance_criteria: ["The feature is complete."],
                id: "REQ-1",
                statement: "Implement the complete feature.",
              },
            ],
            risks: [],
            tasks: [
              {
                acceptance_criteria: ["The task passes."],
                dependencies: [],
                key: "task",
                objective: "Implement the bounded feature.",
                requirement_ids: ["REQ-1"],
                title: "Implement feature",
                verification_commands: ["rustc --version"],
                write_scopes: architectureRuns === 1 ? [] : ["feature.txt"],
              },
            ],
          })
        }
        if (options.body.agent === "Cycle Executor") {
          executorRuns += 1
          executorPrompts.push(prompt)
          await writeFile(
            join(options.query.directory, "feature.txt"),
            executorRuns === 1 ? "first candidate\n" : "repaired candidate\n",
          )
          return response({ status: "submitted", summary: `Execution ${executorRuns}` })
        }
        if (
          options.body.agent === "Cycle Functional Reviewer" &&
          prompt.includes("Independently review one submitted task")
        ) {
          taskReviewRuns += 1
          return response(
            taskReviewRuns === 1 ? taskReviewRejection(prompt) : taskReviewVerdict(prompt),
          )
        }
        if (options.body.agent.includes("Reviewer")) {
          if (mode === "quick") throw new Error("Quick mode started an independent reviewer")
          return response(reviewVerdict(evidenceId))
        }
        if (options.body.agent === "Cycle Arbiter") {
          arbiterRuns += 1
          return response(
            arbiterRuns === 1
              ? {
                  decision: "rejected",
                  findings: [
                    {
                      evidence_ids: [evidenceId],
                      severity: "medium",
                      summary: "Repair the implementation.",
                    },
                  ],
                  repair_target: "execution",
                  requirements: [
                    {
                      evidence_ids: [evidenceId],
                      requirement_id: "REQ-1",
                      status: "unsatisfied",
                    },
                  ],
                }
              : reviewVerdict(evidenceId),
          )
        }
        throw new Error(`Unexpected agent: ${options.body.agent}`)
      },
    },
  }
  const controlPlane = {
    async audit() {
      return { entryHash: "a".repeat(64), sequence: 1 }
    },
    async control() {
      statusCalls += 1
      return { state: statusCalls === 1 ? "paused" : "execution" }
    },
    async freezeCandidate(
      _project: string,
      _workflow: string,
      _base: string,
      _plan: string,
      evidenceIds: string[],
    ) {
      return {
        candidateDigest: executorRuns.toString().repeat(64).slice(0, 64),
        candidateId: crypto.randomUUID(),
        manifest: {
          base_revision: baseRevision,
          candidate_id: crypto.randomUUID(),
          configuration_digest: "b".repeat(64),
          dependency_state_digest: "c".repeat(64),
          diff_digest: "d".repeat(64),
          environment_digest: "e".repeat(64),
          evidence_ids: evidenceIds,
          files: [
            {
              digest: "f".repeat(64),
              kind: "modified" as const,
              path: "feature.txt",
            },
          ],
        },
      }
    },
    async planVerification() {
      evidenceId = crypto.randomUUID()
      return { evidenceIds: [evidenceId], planId: crypto.randomUUID() }
    },
    async prepareWorktree() {
      return { baseRevision, path: repository }
    },
    async promoteCandidate() {
      return { changedPaths: ["feature.txt"], workflowState: "completed" }
    },
    async reportExecution() {
      throw new Error("Execution reporting was not expected")
    },
    async submitArchitecture() {},
    async submitArbitration() {
      return {
        decision: arbiterRuns === 1 ? "rejected" : "approved",
        receipt: {},
        receiptDigest: "9".repeat(64),
        workflowState: arbiterRuns === 1 ? "execution" : "delivery",
      }
    },
    async submitReview() {
      if (mode === "quick") throw new Error("Quick mode submitted an independent review")
      return { reviewsReady: true }
    },
    async verifyCandidate(
      _projectKey: string,
      _workflowId: string,
      _candidateId: string,
      _planId: string,
      attestations: readonly unknown[],
    ) {
      verificationAttestations.push(attestations)
      return {
        evidence: [
          {
            output: "passed",
            record: {
              candidate_digest: executorRuns.toString().repeat(64).slice(0, 64),
              exit_code: 0,
              finished_at: "2026-08-12T10:00:01Z",
              id: evidenceId,
              invocation: "rustc --version",
              kind: "test" as const,
              output_digest: "8".repeat(64),
              skip_reason: null,
              started_at: "2026-08-12T10:00:00Z",
              status: "passed" as const,
              tool: "rustc",
              tool_version: "1",
            },
          },
        ],
        mandatoryPassed: true,
        workflowState: mode === "full" ? "independent_reviews" : "arbitration",
      }
    },
  }
  try {
    const result = await runFullWorkflow(client as never, controlPlane as never, {
      activeModel: null,
      activeVariant: null,
      browserAttestations: async (sessionIds, candidateDigest) => [{
        candidate_digest: candidateDigest,
        receipt_digest: "7".repeat(64),
        receipt_json: "{}",
        session_id: sessionIds[0] as string,
      }],
      models: {
        architect: "provider-a/architect",
        executor: "provider-b/executor",
        functional_reviewer: "provider-c/functional",
        security_reviewer: "provider-d/security",
        arbiter: "provider-e/arbiter",
      },
      variants: {
        architect: "xhigh",
        executor: "max",
        functional_reviewer: "thinking",
        security_reviewer: "max",
        arbiter: "xhigh",
      },
      mode,
      originalRequest: "Build the requested feature exactly.",
      parentSessionId: "parent",
      projectKey: "project",
      registerSession: (session) => sessions.push(session),
      requestDigest: "a".repeat(64),
      signal: controller.signal,
      sourceDirectory: repository,
      workflowId: crypto.randomUUID(),
    })

    expect(result.state).toBe("completed")
    expect(architectureRuns).toBe(2)
    expect(architectPrompts[1]).toContain("at least one write scope")
    expect(executorRuns).toBe(3)
    expect(taskReviewRuns).toBe(3)
    expect(arbiterRuns).toBe(2)
    expect(verificationAttestations).toHaveLength(2)
    expect(verificationAttestations[0]).toEqual([
      expect.objectContaining({ candidate_digest: "2".repeat(64) }),
    ])
    expect(verificationAttestations[1]).toEqual([
      expect.objectContaining({ candidate_digest: "3".repeat(64) }),
    ])
    expect(statusCalls).toBeGreaterThan(1)
    expect(executorPrompts[1]).toContain("Independent task review rejected")
    expect(executorPrompts[2]).toContain("Repair the implementation.")
    expect(sessions.length).toBe(mode === "full" ? 14 : 10)
    expect(childSignals.length).toBeGreaterThan(0)
    expect(childSignals.every((signal) => signal === controller.signal)).toBeTrue()
    expect(launchedModels.get("Cycle Architect")).toEqual({ providerID: "provider-a", modelID: "architect" })
    expect(launchedModels.get("Cycle Executor")).toEqual({ providerID: "provider-b", modelID: "executor" })
    expect(launchedModels.get("Cycle Arbiter")).toEqual({ providerID: "provider-e", modelID: "arbiter" })
    expect(launchedVariants.get("Cycle Architect")).toBe("xhigh")
    expect(launchedVariants.get("Cycle Executor")).toBe("max")
    expect(launchedVariants.get("Cycle Arbiter")).toBe("xhigh")
    if (mode === "full") {
      expect(launchedModels.get("Cycle Functional Reviewer")).toEqual({
        providerID: "provider-c",
        modelID: "functional",
      })
      expect(launchedModels.get("Cycle Security and Architecture Reviewer")).toEqual({
        providerID: "provider-d",
        modelID: "security",
      })
      expect(launchedVariants.get("Cycle Functional Reviewer")).toBe("thinking")
      expect(launchedVariants.get("Cycle Security and Architecture Reviewer")).toBe("max")
    }
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
  }, 60_000)
}

function taskReviewVerdict(prompt: string) {
  const taskId = prompt.match(/"id":"([0-9a-f-]{36})"/u)?.[1] ?? ""
  const revision = prompt.match(/"revision":"([0-9a-f]{40})"/u)?.[1] ?? ""
  const evidenceId = prompt.match(/"commands":\[\{[^}]*"id":"([0-9a-f-]{36})"/u)?.[1] ?? ""
  return {
    decision: "approved",
    findings: [],
    repair_target: null,
    requirements: [
      {
        evidence_ids: [evidenceId],
        requirement_id: "REQ-1",
        status: "satisfied",
      },
    ],
    revision,
    task_id: taskId,
  }
}

function taskReviewRejection(prompt: string) {
  const verdict = taskReviewVerdict(prompt)
  return {
    ...verdict,
    decision: "rejected",
    findings: [
      {
        evidence_ids: verdict.requirements[0]?.evidence_ids ?? [],
        severity: "medium",
        summary: "The submitted task does not satisfy the acceptance criterion.",
      },
    ],
    repair_target: "execution",
    requirements: verdict.requirements.map((requirement) => ({
      ...requirement,
      status: "unsatisfied",
    })),
  }
}

function reviewVerdict(currentEvidenceId: string) {
  return {
    decision: "approved",
    findings: [],
    repair_target: null,
    requirements: [
      {
        evidence_ids: [currentEvidenceId],
        requirement_id: "REQ-1",
        status: "satisfied",
      },
    ],
  }
}

function response(value: unknown) {
  return { data: { parts: [{ text: JSON.stringify(value), type: "text" }] } }
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "opencode-cycle-loop-"))
  for (const argumentsList of [
    ["init"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test User"],
    ["config", "core.hooksPath", ".git/hooks"],
    ["config", "core.autocrlf", "false"],
  ]) {
    await git(repository, argumentsList)
  }
  await writeFile(join(repository, "feature.txt"), "base\n")
  await git(repository, ["add", "."])
  await git(repository, ["commit", "-m", "base"])
  return repository
}

function git(directory: string, argumentsList: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", directory, ...argumentsList], { encoding: "utf8" }, (error, stdout) => {
      if (error === null) resolve(stdout.trim())
      else reject(error)
    })
  })
}
