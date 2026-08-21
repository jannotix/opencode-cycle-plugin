use std::{num::NonZeroUsize, path::Path};

use tempfile::TempDir;
use workflow_core::{
    ActionSafety, SessionId, TaskCommand, TaskId, WorkflowCommand, WorkflowId, WorkflowTimestamp,
};
use workflow_store::{LeaseAcquisition, Store};

fn prepared_store(path: &Path) -> (Store, TaskId) {
    let mut store = Store::open(path, NonZeroUsize::new(2).unwrap()).unwrap();
    let workflow_id = WorkflowId::new();
    let task_id = TaskId::new();
    let timestamp = WorkflowTimestamp::now();
    store
        .apply_workflow_command(
            workflow_id,
            "workflow",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_task_command(
            workflow_id,
            task_id,
            "task",
            TaskCommand::DependenciesSatisfied,
            timestamp,
        )
        .unwrap();
    (store, task_id)
}

#[test]
fn task_has_at_most_one_valid_execution_lease() {
    let temporary = TempDir::new().unwrap();
    let (mut store, task_id) = prepared_store(&temporary.path().join("workflow.db"));
    let first = store
        .acquire_lease(task_id, SessionId::new(), 100, 50, ActionSafety::Idempotent)
        .unwrap();
    let second = store
        .acquire_lease(task_id, SessionId::new(), 110, 50, ActionSafety::Idempotent)
        .unwrap();
    assert!(matches!(first, LeaseAcquisition::Acquired(_)));
    assert!(matches!(second, LeaseAcquisition::Occupied(_)));
}

#[test]
fn expired_idempotent_lease_is_replaced_but_uncertain_action_is_not_replayed() {
    let temporary = TempDir::new().unwrap();
    let (mut store, task_id) = prepared_store(&temporary.path().join("idempotent.db"));
    let first = match store
        .acquire_lease(task_id, SessionId::new(), 0, 10, ActionSafety::Idempotent)
        .unwrap()
    {
        LeaseAcquisition::Acquired(lease) => lease,
        _ => panic!("first lease must be acquired"),
    };
    let replacement = store
        .acquire_lease(task_id, SessionId::new(), 11, 10, ActionSafety::Idempotent)
        .unwrap();
    assert!(matches!(
        replacement,
        LeaseAcquisition::Acquired(lease) if lease.id() != first.id()
    ));

    let (mut store, task_id) = prepared_store(&temporary.path().join("non-idempotent.db"));
    store
        .acquire_lease(
            task_id,
            SessionId::new(),
            0,
            10,
            ActionSafety::NonIdempotent,
        )
        .unwrap();
    let reconciliation = store
        .acquire_lease(
            task_id,
            SessionId::new(),
            11,
            10,
            ActionSafety::NonIdempotent,
        )
        .unwrap();
    assert!(matches!(
        reconciliation,
        LeaseAcquisition::ManualReviewRequired(_)
    ));
}
