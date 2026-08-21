import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"

import { ControlPlaneError, LocalControlPlane } from "../src/client.js"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const binary = join(root, "target", "debug", process.platform === "win32" ? "workflowd.exe" : "workflowd")

test("plugin starts, authenticates, and validates the real control plane", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "opencode-cycle-"))
  const controlPlane = new LocalControlPlane({
    binaryPath: binary,
    dataDirectory,
    stopOwnedProcessOnDispose: true,
  })
  try {
    const initial = await controlPlane.health()
    expect(initial.protocol_version).toBe(1)
    expect(initial.schema_version).toBe(17)
    expect(initial.schema_mode).toBe("read_write")
    expect(await controlPlane.health()).toEqual(initial)
    expect(await controlPlane.control("new-project", "doctor")).toMatchObject({
      ledger: "valid",
      schemaVersion: 17,
      storeMode: "ReadWrite",
    })

    const receipt = await controlPlane.audit({
      actor_id: "integration-test",
      candidate_id: null,
      data: { action: "request_received", type: "workflow" },
      evidence_ids: [],
      files: ["src/index.ts"],
      metadata: { request_digest: "safe-digest" },
      model: { model: "configured-model", provider: "configured-provider" },
      project_key: "integration-project",
      role: null,
      session_id: "session-1",
      task_id: null,
      timestamp_unix_millis: Date.now(),
      workflow_id: null,
    })
    expect(receipt.sequence).toBe(0)
    expect(receipt.entryHash).toMatch(/^[0-9a-f]{64}$/u)
    const database = new Database(join(dataDirectory, "control-plane.db"), { readonly: true })
    expect(database.query("SELECT count(*) AS count FROM ledger_entries").get()).toEqual({ count: 1 })
    expect(database.query("SELECT count(*) AS count FROM ledger_checkpoints").get()).toEqual({
      count: 1,
    })
    database.close()

    const history = (await controlPlane.history("integration-project", {
      after_sequence: null,
      limit: 10,
      type: "query",
    })) as { entries: { sequence: number }[]; next_sequence: number | null }
    expect(history.entries.map((entry) => entry.sequence)).toEqual([0])
    expect(history.next_sequence).toBeNull()
    const verification = (await controlPlane.history("integration-project", {
      type: "verify",
    })) as { chain: { status: string }; checkpoints: { status: string }[] }
    expect(verification.chain.status).toBe("valid")
    expect(verification.checkpoints).toEqual([{ sequence: 0, status: "valid" }])
    expect(
      await controlPlane.memory("integration-project", {
        confidence: null,
        limit: 10,
        scope: null,
        text: "",
        type: "search",
      }),
    ).toEqual({ entries: [], truncated: false })

    const goalId = crypto.randomUUID()
    const goal = (await controlPlane.goal("integration-project", {
      constraints: ["Use supported dependencies"],
      goal_id: goalId,
      max_continuations: 5,
      non_goals: [],
      objective: "Deliver a production SaaS",
      session_id: "session-1",
      success_criteria: ["The primary journey passes"],
      type: "create",
    })) as { goalId: string; state: string }
    expect(goal).toMatchObject({ goalId, state: "draft" })
    expect(
      await controlPlane.goal("integration-project", {
        content: "Versioned architecture",
        goal_id: goalId,
        source_session_id: "architect-session",
        type: "save_plan",
      }),
    ).toEqual({ goalId, revision: 1 })
    expect(
      await controlPlane.goal("integration-project", {
        goal_id: null,
        session_id: "session-1",
        type: "status",
      }),
    ).toMatchObject({ goalId, state: "planning" })

    const workflowId = crypto.randomUUID()
    const repository = join(dataDirectory, "project")
    const hooks = join(dataDirectory, "hooks")
    await mkdir(repository)
    await mkdir(hooks)
    for (const argumentsList of [
      ["init"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test User"],
      ["config", "core.hooksPath", hooks],
    ]) {
      await execGit(repository, argumentsList)
    }
    await writeFile(join(repository, "tracked.txt"), "base\n")
    await writeFile(join(repository, "src.ts"), "export const ready = true\n")
    await execGit(repository, ["add", "tracked.txt", "src.ts"])
    await execGit(repository, ["commit", "-m", "base"])
    const workflow = await controlPlane.startWorkflow({
      affectedPaths: ["migrations/001_users.sql"],
      originalRequest: "Add a database migration and update the public API.",
      preference: "auto",
      projectKey: "integration-project",
      workflowId,
    })
    expect(workflow).toEqual({
      mode: "full",
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      workflowId,
    })
    expect(
      await controlPlane.goal("integration-project", {
        goal_id: goalId,
        milestone: "foundation",
        type: "link_workflow",
        workflow_id: workflowId,
      }),
    ).toMatchObject({
      goalId,
      workflows: [{ milestone: "foundation", workflowId }],
    })
    const indexed = await controlPlane.codeIndex(
      "integration-project",
      workflowId,
      repository,
    )
    expect(indexed.index).toMatchObject({ parsedFiles: 1, reused: false })
    expect(indexed.context.nodes.length).toBeGreaterThan(0)
    expect(
      await controlPlane.codeIndex("integration-project", workflowId, repository),
    ).toMatchObject({ index: { parsedFiles: 0, reused: true } })
    const acquired = await controlPlane.admission(
      "integration-project",
      workflowId,
      repository,
      "acquire",
    )
    expect(acquired.maximumActive).toBeGreaterThan(0)
    expect(acquired.active).toBeGreaterThanOrEqual(0)
    if (acquired.admitted) {
      expect(
        await controlPlane.admission("integration-project", workflowId, repository, "renew"),
      ).toMatchObject({ admitted: true, reason: null })
    } else {
      expect(acquired.reason).toBeString()
    }
    expect(
      await controlPlane.admission("integration-project", workflowId, repository, "release"),
    ).toMatchObject({ admitted: false, reason: "released" })
    expect(await controlPlane.control("integration-project", "status")).toMatchObject({
      maximumRepairCycles: 5,
      mode: "full",
      state: "architecture",
      workflowId,
    })
    expect(await controlPlane.control("integration-project", "tasks")).toEqual({
      tasks: [],
      workflowId,
    })
    expect(await controlPlane.control("integration-project", "pause")).toMatchObject({
      state: "paused",
      workflowId,
    })
    expect(await controlPlane.control("integration-project", "resume")).toMatchObject({
      state: "architecture",
      workflowId,
    })
    expect(
      await controlPlane.startWorkflow({
        affectedPaths: ["migrations/001_users.sql"],
        originalRequest: "Add a database migration and update the public API.",
        preference: "auto",
        projectKey: "integration-project",
        workflowId,
      }),
    ).toEqual(workflow)
    const architecture = {
      assumptions: [],
      integration_checks: ["Run the real integration test."],
      request_digest: workflow.requestDigest,
      requirements: [
        {
          acceptance_criteria: ["The migration and API work together."],
          id: "REQ-1",
          statement: "Add the database migration and public API change.",
        },
      ],
      risks: ["Database migration"],
      tasks: [
        {
          acceptance_criteria: ["The migration and API integration test passes."],
          dependencies: [],
          id: crypto.randomUUID(),
          objective: "Implement and verify the bounded migration and API change.",
          requirement_ids: ["REQ-1"],
          title: "Implement migration and API",
          verification_commands: ['bun -e "await Bun.sleep(11000)"'],
          write_scopes: ["src"],
        },
      ],
    }
    await controlPlane.submitArchitecture("integration-project", workflowId, architecture)
    await controlPlane.submitArchitecture("integration-project", workflowId, architecture)
    const worktree = await controlPlane.prepareWorktree(
      "integration-project",
      repository,
      workflowId,
    )
    expect(worktree.baseRevision).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
    expect(containedIn(worktree.path, join(dataDirectory, "worktrees"))).toBeTrue()
    expect(
      await controlPlane.prepareWorktree("integration-project", repository, workflowId),
    ).toEqual(worktree)
    await writeFile(join(worktree.path, "tracked.txt"), "approved candidate\n")
    await execGit(worktree.path, ["add", "tracked.txt"])
    await execGit(worktree.path, ["commit", "-m", "candidate"])
    const verificationPlan = await controlPlane.planVerification("integration-project", workflowId)
    expect(verificationPlan.evidenceIds.length).toBeGreaterThanOrEqual(3)
    const candidateId = crypto.randomUUID()
    const candidate = await controlPlane.freezeCandidate(
      "integration-project",
      workflowId,
      worktree.baseRevision,
      verificationPlan.planId,
      verificationPlan.evidenceIds,
      candidateId,
    )
    expect(candidate.candidateId).toBe(candidateId)
    expect(candidate.candidateDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(candidate.manifest.files).toEqual([
      {
        digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        kind: "modified",
        path: "tracked.txt",
      },
    ])
    expect(candidate.manifest.evidence_ids).toEqual(verificationPlan.evidenceIds)
    expect(
      await controlPlane.freezeCandidate(
        "integration-project",
        workflowId,
        worktree.baseRevision,
        verificationPlan.planId,
        verificationPlan.evidenceIds,
        candidateId,
      ),
    ).toEqual(candidate)
    const candidateVerification = await controlPlane.verifyCandidate(
      "integration-project",
      workflowId,
      candidateId,
      verificationPlan.planId,
    )
    expect(candidateVerification.mandatoryPassed).toBeTrue()
    expect(candidateVerification.workflowState).toBe("independent_reviews")
    expect(candidateVerification.evidence).toHaveLength(verificationPlan.evidenceIds.length)
    const review = (role: "functional_reviewer" | "security_architecture_reviewer") => ({
      candidate_digest: candidate.candidateDigest,
      decision: "approved" as const,
      findings: [],
      repair_target: null,
      requirements: [
        {
          evidence_ids: verificationPlan.evidenceIds,
          requirement_id: "REQ-1",
          status: "satisfied" as const,
        },
      ],
      role,
    })
    expect(
      await controlPlane.submitReview(
        "integration-project",
        workflowId,
        candidateId,
        review("functional_reviewer"),
      ),
    ).toEqual({ reviewsReady: false })
    expect(
      await controlPlane.submitReview(
        "integration-project",
        workflowId,
        candidateId,
        review("security_architecture_reviewer"),
      ),
    ).toEqual({ reviewsReady: true })
    const arbitrationVerdict = {
      candidate_digest: candidate.candidateDigest,
      decision: "approved" as const,
      findings: [],
      repair_target: null,
      requirements: [
        {
          evidence_ids: verificationPlan.evidenceIds,
          requirement_id: "REQ-1",
          status: "satisfied" as const,
        },
      ],
    }
    const arbitration = await controlPlane.submitArbitration(
      "integration-project",
      workflowId,
      candidateId,
      arbitrationVerdict,
    )
    expect(arbitration.decision).toBe("approved")
    expect(arbitration.workflowState).toBe("delivery")
    expect(arbitration.receipt.candidate_digest).toBe(candidate.candidateDigest)
    expect(arbitration.receipt.request_digest).toBe(workflow.requestDigest)
    expect(arbitration.receipt.functional_review_digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(arbitration.receipt.security_review_digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(
      await controlPlane.submitArbitration(
        "integration-project",
        workflowId,
        candidateId,
        arbitrationVerdict,
      ),
    ).toEqual(arbitration)
    const promotion = await controlPlane.promoteCandidate(
      "integration-project",
      workflowId,
      candidateId,
      repository,
    )
    expect(promotion).toEqual({ changedPaths: ["tracked.txt"], workflowState: "completed" })
    expect(
      await controlPlane.promoteCandidate(
        "integration-project",
        workflowId,
        candidateId,
        repository,
      ),
    ).toEqual(promotion)
    expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("approved candidate\n")
    const routedDatabase = new Database(join(dataDirectory, "control-plane.db"), { readonly: true })
    expect(routedDatabase.query("SELECT count(*) AS count FROM workflows").get()).toEqual({ count: 1 })
    expect(routedDatabase.query("SELECT count(*) AS count FROM workflow_requests").get()).toEqual({
      count: 1,
    })
    expect(
      routedDatabase.query("SELECT count(*) AS count FROM workflow_architecture").get(),
    ).toEqual({ count: 1 })
    expect(
      routedDatabase.query("SELECT state_json FROM workflows WHERE id = ?").get(workflowId),
    ).toEqual({
      state_json: expect.stringContaining('"state":"completed"'),
    })
    expect(routedDatabase.query("SELECT count(*) AS count FROM ledger_entries").get()).toEqual({
      count: 10 + verificationPlan.evidenceIds.length,
    })
    expect(routedDatabase.query("SELECT count(*) AS count FROM workflow_constraints").get()).toEqual({
      count: 1,
    })
    expect(routedDatabase.query("SELECT count(*) AS count FROM workflow_candidates").get()).toEqual({
      count: 1,
    })
    expect(routedDatabase.query("SELECT count(*) AS count FROM workflow_evidence").get()).toEqual({
      count: verificationPlan.evidenceIds.length,
    })
    expect(routedDatabase.query("SELECT count(*) AS count FROM workflow_reviews").get()).toEqual({
      count: 2,
    })
    expect(routedDatabase.query("SELECT count(*) AS count FROM workflow_arbitration").get()).toEqual({
      count: 1,
    })
    routedDatabase.close()

    const quickWorkflowId = crypto.randomUUID()
    const quickWorkflow = await controlPlane.startWorkflow({
      affectedPaths: ["tracked.txt"],
      originalRequest: "Change one label in the tracked file.",
      preference: "quick",
      projectKey: "integration-project",
      workflowId: quickWorkflowId,
    })
    expect(quickWorkflow.mode).toBe("quick")
    const quickArchitecture = {
      assumptions: [],
      integration_checks: ["Run the bounded verification command."],
      request_digest: quickWorkflow.requestDigest,
      requirements: [
        {
          acceptance_criteria: ["The bounded verification command passes."],
          id: "REQ-1",
          statement: "Apply the requested narrow update.",
        },
      ],
      risks: [],
      tasks: [
        {
          acceptance_criteria: ["The bounded verification command passes."],
          dependencies: [],
          id: crypto.randomUUID(),
          objective: "Apply and verify the narrow change.",
          requirement_ids: ["REQ-1"],
          title: "Apply narrow update",
          verification_commands: ["rustc --version"],
          write_scopes: ["ui/page.tsx"],
        },
      ],
    }
    await controlPlane.submitArchitecture(
      "integration-project",
      quickWorkflowId,
      quickArchitecture,
    )
    const quickWorktree = await controlPlane.prepareWorktree(
      "integration-project",
      repository,
      quickWorkflowId,
    )
    const quickVerificationPlan = await controlPlane.planVerification(
      "integration-project",
      quickWorkflowId,
    )
    const quickCandidate = await controlPlane.freezeCandidate(
      "integration-project",
      quickWorkflowId,
      quickWorktree.baseRevision,
      quickVerificationPlan.planId,
      quickVerificationPlan.evidenceIds,
    )
    const browserReceipt = `${JSON.stringify({
      actions: ["open", "snapshot", "check", "screenshot", "logs", "close"].map((operation) => ({
        digest: createHash("sha256").update(operation).digest("hex"),
        operation,
        timestamp: "2026-08-15T12:00:00.000Z",
        url: "http://127.0.0.1:8766/index.html",
      })),
      logs: [],
    })}\n`
    const quickVerification = await controlPlane.verifyCandidate(
      "integration-project",
      quickWorkflowId,
      quickCandidate.candidateId,
      quickVerificationPlan.planId,
      [{
        candidate_digest: quickCandidate.candidateDigest,
        receipt_digest: createHash("sha256").update(browserReceipt).digest("hex"),
        receipt_json: browserReceipt,
        session_id: "executor-browser-session",
      }],
    )
    expect(quickVerification.mandatoryPassed).toBeTrue()
    expect(quickVerification.workflowState).toBe("arbitration")
    expect(
      quickVerification.evidence.filter(
        (evidence) => evidence.record.tool === "opencode-cycle-managed-browser",
      ),
    ).toHaveLength(2)
    await expect(
      controlPlane.submitReview(
        "integration-project",
        quickWorkflowId,
        quickCandidate.candidateId,
        {
          ...review("functional_reviewer"),
          candidate_digest: quickCandidate.candidateDigest,
        },
      ),
    ).rejects.toThrow(ControlPlaneError)
    const quickArbitration = await controlPlane.submitArbitration(
      "integration-project",
      quickWorkflowId,
      quickCandidate.candidateId,
      {
        candidate_digest: quickCandidate.candidateDigest,
        decision: "approved",
        findings: [],
        repair_target: null,
        requirements: [
          {
            evidence_ids: quickVerificationPlan.evidenceIds,
            requirement_id: "REQ-1",
            status: "satisfied",
          },
        ],
      },
    )
    expect(quickArbitration.workflowState).toBe("delivery")
    expect(quickArbitration.receipt.functional_review_digest).toBeNull()
    expect(quickArbitration.receipt.security_review_digest).toBeNull()
    expect(
      await controlPlane.promoteCandidate(
        "integration-project",
        quickWorkflowId,
        quickCandidate.candidateId,
        repository,
      ),
    ).toEqual({ changedPaths: [], workflowState: "completed" })
    const completedDatabase = new Database(join(dataDirectory, "control-plane.db"), {
      readonly: true,
    })
    expect(completedDatabase.query("SELECT count(*) AS count FROM workflows").get()).toEqual({
      count: 2,
    })
    expect(completedDatabase.query("SELECT count(*) AS count FROM workflow_reviews").get()).toEqual(
      { count: 2 },
    )
    completedDatabase.close()

    const incompatible = new LocalControlPlane({
      binaryPath: binary,
      dataDirectory,
      expectedProtocolVersion: 99,
    })
    expect(incompatible.health()).rejects.toThrow(ControlPlaneError)
  } finally {
    await controlPlane.dispose()
    await rm(dataDirectory, { force: true, recursive: true })
  }
}, 60_000)

function containedIn(path: string, directory: string): boolean {
  const value = normalizeWindowsPath(path)
  const root = normalizeWindowsPath(directory).replace(/\/$/u, "")
  return value === root || value.startsWith(`${root}/`)
}

function normalizeWindowsPath(path: string): string {
  let value = resolve(path).replaceAll("\\", "/")
  if (value.startsWith("//?/")) value = value.slice(4)
  return value.toLowerCase()
}

test("stale workflowd is reclaimed and a replacement daemon becomes healthy", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "opencode-cycle-"))
  const controlPlane = new LocalControlPlane({
    binaryPath: binary,
    dataDirectory,
    stopOwnedProcessOnDispose: true,
  })
  try {
    const initial = await controlPlane.health()
    expect(initial.protocol_version).toBe(1)
    const pidPath = join(dataDirectory, "runtime", "workflowd.pid")
    const pid = await waitForDaemonPid(pidPath)
    process.kill(pid)
    await waitUntilProcessExits(pid)
    const recovered = await controlPlane.health()
    expect(recovered.protocol_version).toBe(1)
    expect(recovered.schema_mode).toBe("read_write")
    const replacementPid = await waitForDaemonPid(pidPath)
    expect(replacementPid).not.toBe(pid)
    expect(await controlPlane.control("new-project", "doctor")).toMatchObject({
      ledger: "valid",
      schemaVersion: 17,
      storeMode: "ReadWrite",
    })
  } finally {
    await controlPlane.dispose()
    await rm(dataDirectory, { force: true, recursive: true })
  }
}, 60_000)

function execGit(directory: string, argumentsList: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", directory, ...argumentsList], (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}

async function waitUntilProcessExits(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`workflowd pid ${pid} did not exit`)
}

async function waitForDaemonPid(pidPath: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const raw = await readFile(pidPath, "utf8").catch(() => "")
    const pid = Number.parseInt(raw.trim(), 10)
    if (Number.isInteger(pid) && pid > 0) return pid
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("workflowd did not write its pid file")
}
