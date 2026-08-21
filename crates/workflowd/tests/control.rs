use std::{collections::BTreeMap, num::NonZeroUsize};

use workflow_core::{
    ArchitecturePlan, CandidateDigests, CandidateId, CandidateManifest, ContentDigest, EvidenceId,
    EvidenceKind, EvidenceRecord, EvidenceStatus, PlannedTask, ProjectId, ReceiptId, RepairTarget,
    RequestRecord, Requirement, TaskId, VerificationPlanId, WorkflowCommand, WorkflowId,
    WorkflowMode, WorkflowRole, WorkflowTimestamp,
};
use workflow_ipc::ControlOperation;
use workflow_ledger::{Actor, CheckpointKey, EventData, LedgerEvent, Redactor};
use workflow_store::Store;

#[test]
fn native_control_inspects_and_changes_only_the_latest_project_workflow() {
    let temporary = tempfile::tempdir().unwrap();
    let database = temporary.path().join("workflow.db");
    let mut store = Store::open(&database, NonZeroUsize::new(2).unwrap()).unwrap();
    let workflow_id = WorkflowId::new();
    let project_key = "control-project";
    let project_id = ProjectId::from_stable_key(project_key);
    let timestamp = WorkflowTimestamp::now();
    store
        .save_request_once(
            workflow_id,
            project_id,
            &RequestRecord::new("Control request".to_owned(), vec![]),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    let key = CheckpointKey::generate().unwrap();

    let foreign_workflow_id = WorkflowId::new();
    store
        .save_request_once(
            foreign_workflow_id,
            ProjectId::from_stable_key("foreign-project"),
            &RequestRecord::new("Foreign request".to_owned(), vec![]),
            timestamp,
        )
        .unwrap();
    let cross_project = workflowd::control::execute(
        &mut store,
        &key,
        temporary.path(),
        project_key,
        Some(foreign_workflow_id),
        ControlOperation::Status,
        ReceiptId::new(),
    );
    assert_eq!(
        cross_project.unwrap_err(),
        "workflow does not belong to the project"
    );

    let status = workflowd::control::execute(
        &mut store,
        &key,
        temporary.path(),
        project_key,
        None,
        ControlOperation::Status,
        ReceiptId::new(),
    )
    .unwrap();
    assert_eq!(status["workflowId"], workflow_id.to_string());
    assert_eq!(status["state"], "routing");
    assert_eq!(status["maximumRepairCycles"], 5);

    let paused = workflowd::control::execute(
        &mut store,
        &key,
        temporary.path(),
        project_key,
        None,
        ControlOperation::Pause,
        ReceiptId::new(),
    )
    .unwrap();
    assert_eq!(paused["state"], "paused");
    let resumed = workflowd::control::execute(
        &mut store,
        &key,
        temporary.path(),
        project_key,
        Some(workflow_id),
        ControlOperation::Resume,
        ReceiptId::new(),
    )
    .unwrap();
    assert_eq!(resumed["state"], "routing");
}

#[test]
fn doctor_requires_no_existing_workflow_and_verifies_the_store() {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let result = workflowd::control::execute(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        temporary.path(),
        "new-project",
        None,
        ControlOperation::Doctor,
        ReceiptId::new(),
    )
    .unwrap();

    assert_eq!(result["ledger"], "valid");
    assert_eq!(
        result["schemaVersion"],
        workflow_store::CURRENT_SCHEMA_VERSION
    );
}

#[test]
fn recovery_returns_candidate_bound_finalization_context() {
    let temporary = tempfile::tempdir().unwrap();
    let worktrees = temporary.path().join("worktrees");
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let project_key = "recovery-project";
    let project_id = ProjectId::from_stable_key(project_key);
    let request = RequestRecord::new("Recover the exact request.".to_owned(), vec![]);
    let timestamp = WorkflowTimestamp::now();
    store
        .save_request_once(workflow_id, project_id, &request, timestamp)
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "route",
            WorkflowCommand::Route(WorkflowMode::Quick),
            timestamp,
        )
        .unwrap();
    let plan = ArchitecturePlan::validate(
        request.digest(),
        vec![Requirement {
            acceptance_criteria: vec!["The change works.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Implement the requested change.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["Tests pass.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Implement the change.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Implement".to_owned(),
            verification_commands: vec!["cargo test".to_owned()],
            write_scopes: vec!["src/app.rs".to_owned()],
        }],
        vec![],
        vec![],
        vec!["Run tests.".to_owned()],
    )
    .unwrap();
    store
        .save_architecture_once(workflow_id, &plan, timestamp)
        .unwrap();
    let candidate_id = CandidateId::new();
    let evidence_id = EvidenceId::new();
    let candidate = CandidateManifest::new(
        candidate_id,
        Some("base".to_owned()),
        vec![],
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(b"diff"),
            environment: ContentDigest::of(b"environment"),
        },
        vec![evidence_id],
    )
    .unwrap()
    .with_delivery_payload_digest(Some(ContentDigest::of(
        &serde_json::to_vec(&Vec::<(String, String, bool)>::new()).unwrap(),
    )));
    store
        .save_candidate_once(workflow_id, &candidate, b"diff", &[], timestamp)
        .unwrap();
    let verification_plan_id = VerificationPlanId::new();
    store
        .save_verification_plan_once(
            verification_plan_id,
            workflow_id,
            &serde_json::json!({"gates": [], "id": verification_plan_id}),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "candidate",
            WorkflowCommand::CandidateReady(candidate_id),
            timestamp,
        )
        .unwrap();
    let evidence = EvidenceRecord {
        candidate_digest: candidate.digest(),
        exit_code: Some(0),
        finished_at: timestamp,
        id: evidence_id,
        invocation: "cargo test".to_owned(),
        kind: EvidenceKind::Test,
        output_digest: ContentDigest::of(b"passed"),
        skip_reason: None,
        started_at: timestamp,
        status: EvidenceStatus::Passed,
        tool: "cargo".to_owned(),
        tool_version: "1".to_owned(),
    };
    store
        .save_evidence_once(
            verification_plan_id,
            workflow_id,
            candidate_id,
            &evidence,
            "passed",
            true,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "verified",
            WorkflowCommand::VerificationPassed,
            timestamp,
        )
        .unwrap();
    store
        .append_ledger_event(
            LedgerEvent::new(
                Actor {
                    id: "executor".to_owned(),
                    model: None,
                    role: Some(WorkflowRole::Executor),
                    session_id: Some("executor-session".to_owned()),
                },
                Some(candidate_id),
                EventData::Workflow {
                    action: "execution_task_completed".to_owned(),
                },
                [],
                [],
                BTreeMap::new(),
                project_id,
                None,
                timestamp,
                Some(workflow_id),
                &Redactor::default(),
            )
            .unwrap(),
        )
        .unwrap();

    let recovery = workflowd::control::execute(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        &worktrees,
        project_key,
        Some(workflow_id),
        ControlOperation::Recovery,
        ReceiptId::new(),
    )
    .unwrap();

    assert_eq!(recovery["workflowId"], workflow_id.to_string());
    assert_eq!(recovery["state"], "arbitration");
    assert_eq!(recovery["mode"], "quick");
    assert_eq!(recovery["originalRequest"], "Recover the exact request.");
    assert_eq!(recovery["candidateId"], candidate_id.to_string());
    assert_eq!(recovery["candidateDigest"], candidate.digest().to_string());
    assert_eq!(
        recovery["verificationPlanId"],
        verification_plan_id.to_string()
    );
    assert_eq!(
        recovery["executorSessionIds"],
        serde_json::json!(["executor-session"])
    );
    assert_eq!(
        recovery["evidence"][0]["record"]["id"],
        evidence_id.to_string()
    );
    let expected_worktree = worktrees
        .join(project_id.to_string())
        .join(workflow_id.to_string());
    assert_eq!(
        recovery["worktreePath"].as_str(),
        Some(expected_worktree.to_string_lossy().as_ref())
    );

    store
        .apply_workflow_command(
            workflow_id,
            "approved",
            WorkflowCommand::Approve {
                mandatory_gates_passed: true,
            },
            timestamp,
        )
        .unwrap();
    store
        .reserve_candidate_delivery(workflow_id, candidate_id, candidate.digest(), timestamp)
        .unwrap();
    let retry = workflowd::control::execute(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        &worktrees,
        project_key,
        Some(workflow_id),
        ControlOperation::Retry,
        ReceiptId::new(),
    )
    .unwrap();
    assert_eq!(retry["state"], "delivery");
}

#[test]
fn recovery_returns_request_bound_architecture_repair_context() {
    let temporary = tempfile::tempdir().unwrap();
    let worktrees = temporary.path().join("worktrees");
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let project_key = "architecture-recovery-project";
    let project_id = ProjectId::from_stable_key(project_key);
    let request = RequestRecord::new("Repair the architecture exactly.".to_owned(), vec![]);
    let timestamp = WorkflowTimestamp::now();
    store
        .save_request_once(workflow_id, project_id, &request, timestamp)
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "repair-intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "repair-route",
            WorkflowCommand::Route(WorkflowMode::Full),
            timestamp,
        )
        .unwrap();
    let task_id = TaskId::new();
    let plan = ArchitecturePlan::validate(
        request.digest(),
        vec![Requirement {
            acceptance_criteria: vec!["The repair works.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Repair the architecture.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["Tests pass.".to_owned()],
            dependencies: vec![],
            id: task_id,
            objective: "Repair the change.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Repair".to_owned(),
            verification_commands: vec!["cargo test".to_owned()],
            write_scopes: vec!["src/app.rs".to_owned()],
        }],
        vec![],
        vec![],
        vec!["Run tests.".to_owned()],
    )
    .unwrap();
    store
        .save_architecture_once(workflow_id, &plan, timestamp)
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "architecture-ready",
            WorkflowCommand::ArchitectureAccepted,
            timestamp,
        )
        .unwrap();
    let base_revision = "1".repeat(40);
    let candidate_id = CandidateId::new();
    let candidate = CandidateManifest::new(
        candidate_id,
        Some(base_revision.clone()),
        vec![],
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(b"diff"),
            environment: ContentDigest::of(b"environment"),
        },
        vec![],
    )
    .unwrap()
    .with_delivery_payload_digest(Some(ContentDigest::of(
        &serde_json::to_vec(&Vec::<(String, String, bool)>::new()).unwrap(),
    )));
    store
        .save_candidate_once(workflow_id, &candidate, b"diff", &[], timestamp)
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "candidate-ready",
            WorkflowCommand::CandidateReady(candidate_id),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "verification-passed",
            WorkflowCommand::VerificationPassed,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "reviews-ready",
            WorkflowCommand::ReviewsReady,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "rejected",
            WorkflowCommand::Reject(RepairTarget::Architecture),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "begin-repair",
            WorkflowCommand::BeginRepair,
            timestamp,
        )
        .unwrap();
    let expected_worktree = worktrees
        .join(project_id.to_string())
        .join(workflow_id.to_string());
    std::fs::create_dir_all(&expected_worktree).unwrap();

    let recovery = workflowd::control::execute(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        &worktrees,
        project_key,
        Some(workflow_id),
        ControlOperation::Recovery,
        ReceiptId::new(),
    )
    .unwrap();

    assert_eq!(recovery["workflowId"], workflow_id.to_string());
    assert_eq!(recovery["state"], "architecture");
    assert_eq!(recovery["mode"], "full");
    assert_eq!(recovery["originalRequest"], request.original_text());
    assert_eq!(recovery["requestDigest"], request.digest().to_string());
    assert_eq!(recovery["baseRevision"], base_revision);
    assert!(recovery.get("plan").is_none());
    assert_eq!(
        recovery["worktreePath"].as_str(),
        Some(expected_worktree.to_string_lossy().as_ref())
    );
}

#[test]
fn recovery_returns_quick_execution_plan_before_worktree_creation() {
    let temporary = tempfile::tempdir().unwrap();
    let worktrees = temporary.path().join("worktrees");
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let project_key = "quick-recovery-project";
    let project_id = ProjectId::from_stable_key(project_key);
    let request = RequestRecord::new("Resume quick execution.".to_owned(), vec![]);
    let timestamp = WorkflowTimestamp::now();
    store
        .save_request_once(workflow_id, project_id, &request, timestamp)
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "quick-intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "quick-route",
            WorkflowCommand::Route(WorkflowMode::Quick),
            timestamp,
        )
        .unwrap();
    let plan = ArchitecturePlan::validate(
        request.digest(),
        vec![Requirement {
            acceptance_criteria: vec!["The change works.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Resume the quick change.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["Tests pass.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Complete the quick change.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Complete".to_owned(),
            verification_commands: vec!["cargo test".to_owned()],
            write_scopes: vec!["src/app.rs".to_owned()],
        }],
        vec![],
        vec![],
        vec!["Run tests.".to_owned()],
    )
    .unwrap();
    store
        .save_architecture_once(workflow_id, &plan, timestamp)
        .unwrap();

    let recovery = workflowd::control::execute(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        &worktrees,
        project_key,
        Some(workflow_id),
        ControlOperation::Recovery,
        ReceiptId::new(),
    )
    .unwrap();

    assert_eq!(recovery["state"], "quick_execution");
    assert_eq!(recovery["mode"], "quick");
    assert_eq!(recovery["plan"], serde_json::json!(plan));
    assert!(recovery.get("baseRevision").is_none());
    assert!(!worktrees.exists());
}

#[test]
fn recovery_returns_quick_execution_without_architecture() {
    let temporary = tempfile::tempdir().unwrap();
    let worktrees = temporary.path().join("worktrees");
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let project_key = "quick-recovery-without-architecture";
    let project_id = ProjectId::from_stable_key(project_key);
    let request = RequestRecord::new(
        "Resume quick execution before architecture.".to_owned(),
        vec![],
    );
    let timestamp = WorkflowTimestamp::now();
    store
        .save_request_once(workflow_id, project_id, &request, timestamp)
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "quick-intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "quick-route",
            WorkflowCommand::Route(WorkflowMode::Quick),
            timestamp,
        )
        .unwrap();

    let recovery = workflowd::control::execute(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        &worktrees,
        project_key,
        Some(workflow_id),
        ControlOperation::Recovery,
        ReceiptId::new(),
    )
    .unwrap();

    assert_eq!(recovery["state"], "quick_execution");
    assert_eq!(recovery["mode"], "quick");
    assert_eq!(recovery["originalRequest"], request.original_text());
    assert_eq!(recovery["requestDigest"], request.digest().to_string());
    assert!(recovery.get("plan").is_none());
    assert!(recovery.get("baseRevision").is_none());
    assert!(!worktrees.exists());
}

#[test]
fn recovery_preserves_failed_verification_evidence_for_quick_execution_repair() {
    let temporary = tempfile::tempdir().unwrap();
    let worktrees = temporary.path().join("worktrees");
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let project_key = "quick-verification-repair";
    let project_id = ProjectId::from_stable_key(project_key);
    let request = RequestRecord::new("Repair the failed quick verification.".to_owned(), vec![]);
    let timestamp = WorkflowTimestamp::now();
    store
        .save_request_once(workflow_id, project_id, &request, timestamp)
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "verification-repair-intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "verification-repair-route",
            WorkflowCommand::Route(WorkflowMode::Quick),
            timestamp,
        )
        .unwrap();
    let plan = ArchitecturePlan::validate(
        request.digest(),
        vec![Requirement {
            acceptance_criteria: vec!["Verification passes.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Repair the failing verification.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["The failing gate passes.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Repair the failed gate.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Repair verification".to_owned(),
            verification_commands: vec!["cargo test".to_owned()],
            write_scopes: vec!["src/app.rs".to_owned()],
        }],
        vec![],
        vec![],
        vec!["Run tests.".to_owned()],
    )
    .unwrap();
    store
        .save_architecture_once(workflow_id, &plan, timestamp)
        .unwrap();
    let evidence_id = EvidenceId::new();
    let base_revision = "2".repeat(40);
    let candidate_id = CandidateId::new();
    let candidate = CandidateManifest::new(
        candidate_id,
        Some(base_revision.clone()),
        vec![],
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(b"diff"),
            environment: ContentDigest::of(b"environment"),
        },
        vec![evidence_id],
    )
    .unwrap()
    .with_delivery_payload_digest(Some(ContentDigest::of(
        &serde_json::to_vec(&Vec::<(String, String, bool)>::new()).unwrap(),
    )));
    store
        .save_candidate_once(workflow_id, &candidate, b"diff", &[], timestamp)
        .unwrap();
    let plan_id = VerificationPlanId::new();
    store
        .save_verification_plan_once(
            plan_id,
            workflow_id,
            &serde_json::json!({"gates": [], "id": plan_id}),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "verification-repair-candidate",
            WorkflowCommand::CandidateReady(candidate_id),
            timestamp,
        )
        .unwrap();
    let evidence = EvidenceRecord {
        candidate_digest: candidate.digest(),
        exit_code: Some(1),
        finished_at: timestamp,
        id: evidence_id,
        invocation: "cargo test".to_owned(),
        kind: EvidenceKind::Test,
        output_digest: ContentDigest::of(b"test failed"),
        skip_reason: None,
        started_at: timestamp,
        status: EvidenceStatus::Failed,
        tool: "cargo".to_owned(),
        tool_version: "1".to_owned(),
    };
    store
        .save_evidence_once(
            plan_id,
            workflow_id,
            candidate_id,
            &evidence,
            "test failed",
            true,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "verification-rejected",
            WorkflowCommand::VerificationRejected(RepairTarget::Execution),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            "begin-verification-repair",
            WorkflowCommand::BeginRepair,
            timestamp,
        )
        .unwrap();
    let expected_worktree = worktrees
        .join(project_id.to_string())
        .join(workflow_id.to_string());
    std::fs::create_dir_all(&expected_worktree).unwrap();

    let recovery = workflowd::control::execute(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        &worktrees,
        project_key,
        Some(workflow_id),
        ControlOperation::Recovery,
        ReceiptId::new(),
    )
    .unwrap();

    assert_eq!(recovery["state"], "execution");
    assert_eq!(recovery["mode"], "quick");
    assert_eq!(recovery["plan"], serde_json::json!(plan));
    assert_eq!(recovery["baseRevision"], base_revision);
    let feedback: serde_json::Value =
        serde_json::from_str(recovery["repairFeedback"].as_str().unwrap()).unwrap();
    assert_eq!(feedback[0]["mandatory"], true);
    assert_eq!(feedback[0]["output"], "test failed");
    assert_eq!(feedback[0]["record"]["status"], "failed");
}
