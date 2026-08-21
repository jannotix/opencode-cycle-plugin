use std::{num::NonZeroU8, num::NonZeroUsize};

use tempfile::TempDir;
use workflow_core::{
    Goal, GoalCommand, GoalId, GoalState, ProjectId, WorkflowCommand, WorkflowId, WorkflowTimestamp,
};
use workflow_store::Store;

fn store(temporary: &TempDir) -> Store {
    Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap()
}

fn goal() -> Goal {
    Goal::new(
        "Build the SaaS".to_owned(),
        vec!["The primary journey passes end to end".to_owned()],
        vec![],
        vec![],
        NonZeroU8::new(5).unwrap(),
    )
    .unwrap()
}

#[test]
fn persists_goal_focus_plans_and_workflow_links() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let goal_id = GoalId::new();
    let project_id = ProjectId::from_stable_key("project");
    let session_id = "session-1";
    let now = WorkflowTimestamp::now();

    assert!(
        !store
            .save_goal_once(goal_id, project_id, &goal(), now)
            .unwrap()
    );
    assert!(
        store
            .save_goal_once(goal_id, project_id, &goal(), now)
            .unwrap()
    );
    store
        .apply_goal_command(goal_id, "planning", GoalCommand::StartPlanning, now)
        .unwrap();
    store
        .focus_goal(project_id, session_id, goal_id, now)
        .unwrap();
    let first = store
        .save_goal_plan(goal_id, session_id, "Architecture draft", now)
        .unwrap();
    let duplicate = store
        .save_goal_plan(goal_id, session_id, "Architecture draft", now)
        .unwrap();

    assert_eq!(first, 1);
    assert_eq!(duplicate, 1);
    assert_eq!(
        store.focused_goal(project_id, session_id).unwrap(),
        Some(goal_id)
    );
    assert_eq!(
        store.load_goal(goal_id).unwrap().unwrap().1.state(),
        GoalState::Planning
    );
    assert_eq!(
        store
            .load_latest_goal_plan(goal_id)
            .unwrap()
            .unwrap()
            .revision,
        1
    );

    let workflow_id = WorkflowId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "workflow-intake",
            WorkflowCommand::CompleteIntake,
            now,
        )
        .unwrap();
    store
        .link_goal_workflow(goal_id, workflow_id, "foundation", now)
        .unwrap();
    assert_eq!(
        store.goal_workflows(goal_id).unwrap(),
        vec![(workflow_id, "foundation".to_owned())]
    );
}

#[test]
fn goal_idempotency_conflicts_fail_closed() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let now = WorkflowTimestamp::now();
    let first = GoalId::new();
    let second = GoalId::new();
    let project = ProjectId::from_stable_key("project");
    store.save_goal_once(first, project, &goal(), now).unwrap();
    store.save_goal_once(second, project, &goal(), now).unwrap();
    store
        .apply_goal_command(first, "same-key", GoalCommand::StartPlanning, now)
        .unwrap();

    assert!(
        store
            .apply_goal_command(second, "same-key", GoalCommand::StartPlanning, now)
            .is_err()
    );
}
