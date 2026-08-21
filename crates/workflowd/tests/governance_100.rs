use std::{collections::BTreeSet, num::NonZeroUsize};

use tempfile::TempDir;
use workflow_core::{
    ActionSafety, ProjectId, SessionId, TaskCommand, TaskId, WorkflowCommand, WorkflowId,
    WorkflowState, WorkflowTimestamp,
};
use workflow_store::{LeaseAcquisition, Store};
use workflowd::scheduler::queue::{FairQueue, ScheduledTask, SchedulingState};

#[test]
fn governs_one_hundred_persistent_workflows_without_duplicate_leases() {
    let temporary = TempDir::new().unwrap();
    let database = temporary.path().join("workflow.db");
    let timestamp = WorkflowTimestamp::now();
    let projects: Vec<_> = (0..10).map(|_| ProjectId::new()).collect();
    let mut workflows = Vec::new();
    let mut queue = FairQueue::new();
    let mut store = Store::open(&database, NonZeroUsize::new(4).unwrap()).unwrap();

    for index in 0..100 {
        let workflow_id = WorkflowId::new();
        let task_id = TaskId::new();
        store
            .apply_workflow_command(
                workflow_id,
                &format!("intake-{index}"),
                WorkflowCommand::CompleteIntake,
                timestamp,
            )
            .unwrap();
        let state = if index % 10 == 0 {
            store
                .apply_workflow_command(
                    workflow_id,
                    &format!("pause-{index}"),
                    WorkflowCommand::Pause,
                    timestamp,
                )
                .unwrap();
            SchedulingState::Paused
        } else if index % 10 == 1 {
            SchedulingState::Blocked
        } else {
            SchedulingState::Ready
        };
        store
            .apply_task_command(
                workflow_id,
                task_id,
                &format!("task-{index}"),
                TaskCommand::DependenciesSatisfied,
                timestamp,
            )
            .unwrap();
        queue.enqueue(
            ScheduledTask {
                priority: i16::try_from(index % 5).unwrap(),
                project_id: projects[index % projects.len()],
                task_id,
                workflow_id,
            },
            state,
        );
        workflows.push((workflow_id, task_id, state));
    }
    drop(store);

    let mut store = Store::open(&database, NonZeroUsize::new(4).unwrap()).unwrap();
    for (workflow_id, _, state) in &workflows {
        let stored = store.load_workflow(*workflow_id).unwrap().unwrap();
        let expected = if *state == SchedulingState::Paused {
            WorkflowState::Paused
        } else {
            WorkflowState::Routing
        };
        assert_eq!(stored.state(), expected);
        if *state == SchedulingState::Paused {
            store
                .apply_workflow_command(
                    *workflow_id,
                    &format!("resume-{workflow_id}"),
                    WorkflowCommand::Resume,
                    timestamp,
                )
                .unwrap();
            queue.set_workflow_state(*workflow_id, SchedulingState::Ready);
        }
    }

    let mut leased_tasks = BTreeSet::new();
    while let Some(task) = queue.pop() {
        assert!(leased_tasks.insert(task.task_id));
        assert!(matches!(
            store
                .acquire_lease(
                    task.task_id,
                    SessionId::new(),
                    0,
                    10_000,
                    ActionSafety::Idempotent
                )
                .unwrap(),
            LeaseAcquisition::Acquired(_)
        ));
    }
    assert_eq!(leased_tasks.len(), 90);
    let persisted_leases: u32 = store
        .writer()
        .unwrap()
        .query_row("SELECT count(*) FROM leases", [], |row| row.get(0))
        .unwrap();
    assert_eq!(persisted_leases, 90);
}
