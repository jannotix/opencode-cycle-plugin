//! The binding-rejection contract: a reviewer's rejection stands, and an arbiter approval that
//! contradicts it is recorded and routed to repair rather than refused by an error that leaves no
//! trace. Delivery stays impossible throughout, and that is asserted rather than assumed.

use std::{collections::BTreeSet, num::NonZeroUsize};

use workflow_core::{
    ArbiterDecision, ArbiterVerdict, ArchitecturePlan, CandidateDigests, CandidateId,
    CandidateManifest, ContentDigest, EvidenceId, EvidenceKind, EvidenceRecord, EvidenceStatus,
    Finding, FindingSeverity, PlannedTask, ProjectId, RepairTarget, RequestRecord, Requirement,
    RequirementDecision, RequirementStatus, ReviewDecision, ReviewVerdict, TaskId,
    VerificationPlanId, WorkflowCommand, WorkflowId, WorkflowMode, WorkflowRole, WorkflowState,
    WorkflowTimestamp,
};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

const PROJECT: &str = "arbitration-project";

struct Fixture {
    candidate: CandidateManifest,
    candidate_id: CandidateId,
    evidence_id: EvidenceId,
    store: Store,
    workflow_id: WorkflowId,
    _temporary: tempfile::TempDir,
}

/// A full-mode workflow standing in arbitration on a frozen candidate whose one mandatory gate
/// passed. Everything below differs only in the two reviews and the arbiter's verdict.
fn arbitration_ready() -> Fixture {
    let temporary = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let project_id = ProjectId::from_stable_key(PROJECT);
    let request = RequestRecord::new("Implement the requested change.".to_owned(), vec![]);
    let timestamp = WorkflowTimestamp::now();

    store
        .save_request_once(workflow_id, project_id, &request, timestamp)
        .unwrap();
    for (key, command) in [
        ("intake", WorkflowCommand::CompleteIntake),
        ("route", WorkflowCommand::Route(WorkflowMode::Full)),
    ] {
        store
            .apply_workflow_command(workflow_id, key, command, timestamp)
            .unwrap();
    }

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
    store
        .apply_workflow_command(
            workflow_id,
            "architecture",
            WorkflowCommand::ArchitectureAccepted,
            timestamp,
        )
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
    store
        .save_evidence_once(
            verification_plan_id,
            workflow_id,
            candidate_id,
            &EvidenceRecord {
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
            },
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

    Fixture {
        candidate,
        candidate_id,
        evidence_id,
        store,
        workflow_id,
        _temporary: temporary,
    }
}

fn review(
    fixture: &Fixture,
    role: WorkflowRole,
    decision: ReviewDecision,
    repair_target: Option<RepairTarget>,
) -> ReviewVerdict {
    let evidence = BTreeSet::from([fixture.evidence_id]);
    ReviewVerdict {
        candidate_digest: fixture.candidate.digest(),
        decision,
        findings: if decision == ReviewDecision::Rejected {
            vec![Finding {
                evidence_ids: evidence.clone(),
                severity: FindingSeverity::Medium,
                summary: "Equal names are not ordered deterministically.".to_owned(),
            }]
        } else {
            vec![]
        },
        repair_target,
        requirements: vec![RequirementDecision {
            evidence_ids: evidence,
            requirement_id: "REQ-1".to_owned(),
            status: if decision == ReviewDecision::Rejected {
                RequirementStatus::Unsatisfied
            } else {
                RequirementStatus::Satisfied
            },
        }],
        role,
    }
}

/// Files both reviews and advances the workflow to arbitration.
fn reviews(fixture: &mut Fixture, security: ReviewDecision, target: Option<RepairTarget>) {
    let timestamp = WorkflowTimestamp::now();
    let functional = review(
        fixture,
        WorkflowRole::FunctionalReviewer,
        ReviewDecision::Approved,
        None,
    );
    let security = review(
        fixture,
        WorkflowRole::SecurityArchitectureReviewer,
        security,
        target,
    );
    for verdict in [functional, security] {
        fixture
            .store
            .save_review_once(
                fixture.workflow_id,
                fixture.candidate_id,
                &verdict,
                timestamp,
            )
            .unwrap();
    }
    fixture
        .store
        .apply_workflow_command(
            fixture.workflow_id,
            "reviewed",
            WorkflowCommand::ReviewsReady,
            timestamp,
        )
        .unwrap();
}

fn approval(fixture: &Fixture) -> ArbiterVerdict {
    ArbiterVerdict {
        candidate_digest: fixture.candidate.digest(),
        decision: ArbiterDecision::Approved,
        findings: vec![],
        repair_target: None,
        requirements: vec![RequirementDecision {
            evidence_ids: BTreeSet::from([fixture.evidence_id]),
            requirement_id: "REQ-1".to_owned(),
            status: RequirementStatus::Satisfied,
        }],
    }
}

/// The workflow actions the chain recorded, in order, with the metadata of each.
fn actions(fixture: &Fixture) -> Vec<(String, std::collections::BTreeMap<String, String>)> {
    fixture
        .store
        .load_ledger()
        .unwrap()
        .entries()
        .iter()
        .filter_map(|entry| match &entry.event.data {
            workflow_ledger::EventData::Workflow { action } => {
                Some((action.clone(), entry.event.metadata.clone()))
            }
            _ => None,
        })
        .collect()
}

fn arbitrate(fixture: &mut Fixture, verdict: &ArbiterVerdict) -> Result<String, String> {
    workflowd::lifecycle::submit_arbitration(
        &mut fixture.store,
        &CheckpointKey::generate().unwrap(),
        PROJECT,
        fixture.workflow_id,
        fixture.candidate_id,
        verdict,
    )
    .map(|(_, state)| state)
}

#[test]
fn an_approval_over_a_rejection_is_recorded_refused_and_routed_to_repair() {
    let mut fixture = arbitration_ready();
    reviews(
        &mut fixture,
        ReviewDecision::Rejected,
        Some(RepairTarget::Execution),
    );
    let verdict = approval(&fixture);

    // It succeeds rather than erroring: the plane refuses the approval, and says so in the record.
    let state = arbitrate(&mut fixture, &verdict).unwrap();
    assert_eq!(state, "execution");

    // The verdict the arbiter actually gave is on record, verbatim. Reading it back as something
    // else would lose what happened, which is the whole reason this stopped being a throw.
    let (owner, stored, _) = fixture
        .store
        .load_arbitration(fixture.candidate_id)
        .unwrap()
        .expect("a refused approval is still an arbitration and must be recorded");
    assert_eq!(owner, fixture.workflow_id);
    assert_eq!(stored, verdict);
    assert_eq!(stored.decision, ArbiterDecision::Approved);

    // The chain names the refusal apart from an ordinary rejection, and names who caused it.
    let recorded = actions(&fixture);
    let metadata = recorded
        .iter()
        .find_map(|(action, metadata)| (action == "arbitration_refused").then_some(metadata))
        .expect("the refusal is named in the chain");
    assert_eq!(
        metadata.get("refused_by").map(String::as_str),
        Some("security_architecture_reviewer"),
    );
    assert_eq!(
        metadata.get("repair_target").map(String::as_str),
        Some("execution"),
    );
    // Not an ordinary rejection, and not an approval: the arbiter approved and the plane refused.
    assert!(
        !recorded
            .iter()
            .any(|(action, _)| action == "arbitration_approved")
    );
}

/// The property that makes recording the approval safe: it cannot become a delivery. Promotion
/// requires the workflow to be awaiting delivery of this candidate, and repair leaves it in neither
/// state — so the saved `Approved` verdict has no path to the repository on its own.
#[test]
fn a_refused_approval_cannot_reach_delivery() {
    let mut fixture = arbitration_ready();
    reviews(
        &mut fixture,
        ReviewDecision::Rejected,
        Some(RepairTarget::Execution),
    );
    let verdict = approval(&fixture);
    arbitrate(&mut fixture, &verdict).unwrap();

    let workflow = fixture
        .store
        .load_workflow(fixture.workflow_id)
        .unwrap()
        .unwrap();
    assert_ne!(workflow.state(), WorkflowState::Delivery);
    assert_ne!(workflow.state(), WorkflowState::Completed);
    // Both halves of the promotion guard fail, not just one.
    assert_ne!(workflow.current_candidate(), Some(fixture.candidate_id));
}

#[test]
fn a_reviewer_asking_for_architecture_sends_the_repair_there() {
    let mut fixture = arbitration_ready();
    reviews(
        &mut fixture,
        ReviewDecision::Rejected,
        Some(RepairTarget::Architecture),
    );

    let verdict = approval(&fixture);
    assert_eq!(arbitrate(&mut fixture, &verdict).unwrap(), "architecture");
}

/// The ordinary path is untouched: two approvals still approve, and the chain still says so.
#[test]
fn an_approval_both_reviewers_support_still_approves() {
    let mut fixture = arbitration_ready();
    reviews(&mut fixture, ReviewDecision::Approved, None);

    let verdict = approval(&fixture);
    assert_eq!(arbitrate(&mut fixture, &verdict).unwrap(), "delivery");

    assert!(
        actions(&fixture)
            .iter()
            .any(|(action, _)| action == "arbitration_approved")
    );
}
