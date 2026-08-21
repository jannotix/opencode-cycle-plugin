use std::num::NonZeroUsize;

use workflow_core::{
    CandidateDigests, CandidateId, CandidateManifest, ContentDigest, EvidenceId, EvidenceKind,
    EvidenceRecord, EvidenceStatus, VerificationPlanId, WorkflowCommand, WorkflowId,
    WorkflowTimestamp,
};
use workflow_store::{Store, StoreError};

fn candidate(candidate_id: CandidateId) -> CandidateManifest {
    CandidateManifest::new(
        candidate_id,
        Some("base".to_owned()),
        Vec::new(),
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(b"diff"),
            environment: ContentDigest::of(b"environment"),
        },
        Vec::new(),
    )
    .unwrap()
    .with_delivery_payload_digest(Some(ContentDigest::of(
        &serde_json::to_vec(&Vec::<(String, String, bool)>::new()).unwrap(),
    )))
}

#[test]
fn evidence_attempts_are_versioned_and_bound_to_plan_workflow_and_candidate() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "verification-test-intake",
            WorkflowCommand::CompleteIntake,
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let candidate_id = CandidateId::new();
    let candidate = candidate(candidate_id);
    store
        .save_candidate_once(
            workflow_id,
            &candidate,
            b"diff",
            &[],
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let plan_id = VerificationPlanId::new();
    let plan = serde_json::json!({"id": plan_id, "gates": []});
    assert!(
        !store
            .save_verification_plan_once(plan_id, workflow_id, &plan, WorkflowTimestamp::now())
            .unwrap()
    );
    let timestamp = WorkflowTimestamp::now();
    let record = EvidenceRecord {
        candidate_digest: candidate.digest(),
        exit_code: Some(0),
        finished_at: timestamp,
        id: EvidenceId::new(),
        invocation: "project-test".to_owned(),
        kind: EvidenceKind::Test,
        output_digest: ContentDigest::of(b"output"),
        skip_reason: None,
        started_at: timestamp,
        status: EvidenceStatus::Passed,
        tool: "project-test".to_owned(),
        tool_version: "1".to_owned(),
    };
    assert!(
        !store
            .save_evidence_once(
                plan_id,
                workflow_id,
                candidate_id,
                &record,
                "passed",
                true,
                WorkflowTimestamp::now()
            )
            .unwrap()
    );
    assert!(store.evidence_exists(record.id).unwrap());
    assert_eq!(
        store.load_candidate_evidence(candidate_id).unwrap(),
        vec![(record.clone(), "passed".to_owned(), true)]
    );
    let changed = EvidenceRecord {
        output_digest: ContentDigest::of(b"changed"),
        ..record.clone()
    };
    assert!(
        !store
            .save_evidence_once(
                plan_id,
                workflow_id,
                candidate_id,
                &changed,
                "changed",
                true,
                WorkflowTimestamp::now()
            )
            .unwrap()
    );
    assert_eq!(
        store.load_candidate_evidence(candidate_id).unwrap(),
        vec![(changed, "changed".to_owned(), true)]
    );
    assert!(matches!(
        store.save_evidence_once(
            plan_id,
            WorkflowId::new(),
            candidate_id,
            &record,
            "passed",
            true,
            WorkflowTimestamp::now()
        ),
        Err(StoreError::AggregateConflict)
    ));
}

#[test]
fn skipped_evidence_keeps_versioned_attempts_and_exposes_the_latest_result() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "verification-retry-intake",
            WorkflowCommand::CompleteIntake,
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let candidate_id = CandidateId::new();
    let candidate = candidate(candidate_id);
    store
        .save_candidate_once(
            workflow_id,
            &candidate,
            b"diff",
            &[],
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let plan_id = VerificationPlanId::new();
    store
        .save_verification_plan_once(
            plan_id,
            workflow_id,
            &serde_json::json!({"id": plan_id, "gates": []}),
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let timestamp = WorkflowTimestamp::now();
    let evidence_id = EvidenceId::new();
    let skipped = EvidenceRecord {
        candidate_digest: candidate.digest(),
        exit_code: None,
        finished_at: timestamp,
        id: evidence_id,
        invocation: "managed-browser".to_owned(),
        kind: EvidenceKind::Browser,
        output_digest: ContentDigest::of(b"unavailable"),
        skip_reason: Some("Browser evidence was unavailable.".to_owned()),
        started_at: timestamp,
        status: EvidenceStatus::Skipped,
        tool: "unavailable".to_owned(),
        tool_version: "unavailable".to_owned(),
    };
    store
        .save_evidence_once(
            plan_id,
            workflow_id,
            candidate_id,
            &skipped,
            "unavailable",
            true,
            timestamp,
        )
        .unwrap();
    let passed = EvidenceRecord {
        exit_code: Some(0),
        output_digest: ContentDigest::of(b"passed"),
        skip_reason: None,
        status: EvidenceStatus::Passed,
        tool: "opencode-cycle-managed-browser".to_owned(),
        tool_version: "1.0.0".to_owned(),
        ..skipped.clone()
    };
    assert!(
        !store
            .save_evidence_once(
                plan_id,
                workflow_id,
                candidate_id,
                &passed,
                "passed",
                true,
                WorkflowTimestamp::now(),
            )
            .unwrap()
    );
    assert_eq!(
        store.load_candidate_evidence(candidate_id).unwrap(),
        vec![(passed.clone(), "passed".to_owned(), true)]
    );
    let attempts: u32 = store
        .writer()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM workflow_evidence_attempts WHERE evidence_id = ?1",
            [evidence_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(attempts, 1);
    let rerun = EvidenceRecord {
        output_digest: ContentDigest::of(b"rerun"),
        ..passed
    };
    assert!(
        !store
            .save_evidence_once(
                plan_id,
                workflow_id,
                candidate_id,
                &rerun,
                "rerun",
                true,
                WorkflowTimestamp::now(),
            )
            .unwrap()
    );
    assert_eq!(
        store.load_candidate_evidence(candidate_id).unwrap(),
        vec![(rerun, "rerun".to_owned(), true)]
    );
}
