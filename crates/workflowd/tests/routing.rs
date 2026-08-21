use std::num::NonZeroUsize;

use workflow_core::{ReceiptId, RiskCategory, UserRoutingPreference, WorkflowId, WorkflowMode};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;
use workflowd::routing::{RoutingRequest, automatic_evidence, decide_and_record};

#[test]
fn generic_request_tokens_do_not_force_full_mode() {
    let evidence = automatic_evidence(
        "Add isEven, update the readme, install nothing, and keep the package tests green.",
        &["src/value.ts".to_owned(), "README.md".to_owned()],
    );
    assert!(
        !evidence
            .facts
            .iter()
            .any(|fact| fact.category.is_critical())
    );
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("control-plane.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let result = decide_and_record(
        &mut store,
        &CheckpointKey::generate().unwrap(),
        RoutingRequest {
            critical_downgrade_approval: None,
            evidence,
            preference: UserRoutingPreference::Auto,
            project_key: "project".to_owned(),
            timestamp_unix_millis: 1,
            workflow_id: WorkflowId::new(),
        },
    )
    .unwrap();
    assert_eq!(result.decision.mode, WorkflowMode::Quick);
}

#[test]
fn automatic_facts_route_cross_layer_database_work_to_full() {
    let evidence = automatic_evidence(
        "Implement the backend, frontend and a database migration.",
        &["migrations/001_users.sql".to_owned()],
    );
    assert!(
        evidence
            .facts
            .iter()
            .any(|fact| fact.category == RiskCategory::CrossLayer)
    );
    assert!(
        evidence
            .facts
            .iter()
            .any(|fact| fact.category == RiskCategory::DatabaseMigration)
    );
}

#[test]
fn route_and_rationale_are_recorded_in_the_project_ledger() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("control-plane.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let key = CheckpointKey::generate().unwrap();
    let result = decide_and_record(
        &mut store,
        &key,
        RoutingRequest {
            critical_downgrade_approval: None,
            evidence: automatic_evidence("Change authentication and the public API", &[]),
            preference: UserRoutingPreference::Auto,
            project_key: "project".to_owned(),
            timestamp_unix_millis: 1,
            workflow_id: WorkflowId::new(),
        },
    )
    .unwrap();

    assert_eq!(result.decision.mode, WorkflowMode::Full);
    assert_eq!(result.ledger_entry.event.metadata["mode"], "full");
    assert!(result.ledger_entry.event.metadata["rationale"].contains("original_request"));
}

#[test]
fn critical_quick_override_needs_a_recorded_receipt() {
    let evidence = automatic_evidence("Apply a database migration", &[]);
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("control-plane.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let key = CheckpointKey::generate().unwrap();
    let workflow_id = WorkflowId::new();
    let denied = decide_and_record(
        &mut store,
        &key,
        RoutingRequest {
            critical_downgrade_approval: None,
            evidence: evidence.clone(),
            preference: UserRoutingPreference::Quick,
            project_key: "project".to_owned(),
            timestamp_unix_millis: 1,
            workflow_id,
        },
    )
    .unwrap();
    assert_eq!(denied.decision.mode, WorkflowMode::Full);
    assert!(denied.decision.downgrade_approval_required);

    let receipt = ReceiptId::new();
    let approved = decide_and_record(
        &mut store,
        &key,
        RoutingRequest {
            critical_downgrade_approval: Some(receipt),
            evidence,
            preference: UserRoutingPreference::Quick,
            project_key: "project".to_owned(),
            timestamp_unix_millis: 2,
            workflow_id,
        },
    )
    .unwrap();
    assert_eq!(approved.decision.mode, WorkflowMode::Quick);
    assert_eq!(approved.decision.downgrade_approval, Some(receipt));
}
