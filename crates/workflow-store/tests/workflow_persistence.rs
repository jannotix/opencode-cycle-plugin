use std::{num::NonZeroUsize, path::Path};

use tempfile::TempDir;
use workflow_core::{
    TaskCommand, TaskId, TaskState, WorkflowCommand, WorkflowId, WorkflowState, WorkflowTimestamp,
};
use workflow_store::{Store, StoreError};

fn open(path: &Path) -> Store {
    Store::open(path, NonZeroUsize::new(2).unwrap()).unwrap()
}

#[test]
fn command_events_and_state_commit_atomically() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("workflow.db");
    let workflow_id = WorkflowId::new();
    let mut store = open(&path);
    let timestamp = WorkflowTimestamp::now();

    let applied = store
        .apply_workflow_command(
            workflow_id,
            "intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    assert_eq!(applied.state.state(), WorkflowState::Routing);
    assert_eq!(applied.events.len(), 1);

    let error = store
        .apply_workflow_command(
            workflow_id,
            "invalid",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap_err();
    assert!(matches!(error, StoreError::Transition(_)));
    let event_count: u32 = store
        .writer()
        .unwrap()
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(event_count, 1);
    assert_eq!(
        store.load_workflow(workflow_id).unwrap().unwrap(),
        applied.state
    );
}

#[test]
fn restart_reconstructs_exact_state_and_duplicate_has_no_second_effect() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("workflow.db");
    let workflow_id = WorkflowId::new();
    let timestamp = WorkflowTimestamp::now();
    let expected = {
        let mut store = open(&path);
        store
            .apply_workflow_command(
                workflow_id,
                "same-key",
                WorkflowCommand::CompleteIntake,
                timestamp,
            )
            .unwrap()
    };

    let mut restarted = open(&path);
    assert_eq!(
        restarted.load_workflow(workflow_id).unwrap(),
        Some(expected.state.clone())
    );
    let duplicate = restarted
        .apply_workflow_command(workflow_id, "same-key", WorkflowCommand::Cancel, timestamp)
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.state, expected.state);
    let event_count: u32 = restarted
        .writer()
        .unwrap()
        .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert_eq!(event_count, 1);
}

#[test]
fn task_state_and_events_share_the_workflow_transaction_store() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("workflow.db");
    let workflow_id = WorkflowId::new();
    let task_id = TaskId::new();
    let timestamp = WorkflowTimestamp::now();
    let mut store = open(&path);
    store
        .apply_workflow_command(
            workflow_id,
            "workflow",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    let ready = store
        .apply_task_command(
            workflow_id,
            task_id,
            "task-ready",
            TaskCommand::DependenciesSatisfied,
            timestamp,
        )
        .unwrap();
    assert_eq!(ready.state.state(), TaskState::Ready);
    drop(store);

    let restarted = open(&path);
    assert_eq!(
        restarted.load_task(task_id).unwrap(),
        Some(ready.state.clone())
    );
    assert_eq!(
        restarted.load_workflow_tasks(workflow_id).unwrap(),
        vec![(task_id, ready.state)]
    );
}

#[test]
fn keys_and_task_identifiers_cannot_cross_aggregate_boundaries() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("workflow.db");
    let first_workflow = WorkflowId::new();
    let second_workflow = WorkflowId::new();
    let task_id = TaskId::new();
    let timestamp = WorkflowTimestamp::now();
    let mut store = open(&path);
    for (id, key) in [(first_workflow, "first"), (second_workflow, "second")] {
        store
            .apply_workflow_command(id, key, WorkflowCommand::CompleteIntake, timestamp)
            .unwrap();
    }
    store
        .apply_task_command(
            first_workflow,
            task_id,
            "task",
            TaskCommand::DependenciesSatisfied,
            timestamp,
        )
        .unwrap();

    assert!(matches!(
        store.apply_task_command(
            second_workflow,
            task_id,
            "other-key",
            TaskCommand::Lease,
            timestamp
        ),
        Err(StoreError::AggregateConflict)
    ));
    assert!(matches!(
        store.apply_task_command(
            first_workflow,
            TaskId::new(),
            "first",
            TaskCommand::DependenciesSatisfied,
            timestamp
        ),
        Err(StoreError::IdempotencyConflict)
    ));
}
