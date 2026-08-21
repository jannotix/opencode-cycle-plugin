use std::num::NonZeroUsize;

use tempfile::TempDir;
use workflow_core::{
    CandidateId, GoalId, ReceiptId, WorkflowCommand, WorkflowId, WorkflowMode, WorkflowTimestamp,
};
use workflow_ipc::{GoalControlAction, GoalOperation};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

fn store(temporary: &TempDir) -> Store {
    Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap()
}

#[test]
fn goal_api_persists_focus_plan_and_state() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = GoalId::new();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Create {
            constraints: vec!["Use supported dependencies".to_owned()],
            goal_id,
            max_continuations: 5,
            non_goals: vec![],
            objective: "Build a production SaaS".to_owned(),
            session_id: "session".to_owned(),
            success_criteria: vec!["The primary journey passes".to_owned()],
        },
    )
    .unwrap();
    let plan = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::SavePlan {
            content: "Versioned architecture".to_owned(),
            goal_id,
            source_session_id: "architect-session".to_owned(),
        },
    )
    .unwrap();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Control {
            action: GoalControlAction::MarkReady,
            completion_evidence: None,
            goal_id,
            operation_id: ReceiptId::new(),
            reason: None,
        },
    )
    .unwrap();

    let status = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Status {
            goal_id: None,
            session_id: "session".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(plan["revision"], 1);
    assert_eq!(status["goalId"], goal_id.to_string());
    assert_eq!(status["state"], "ready");
    assert_eq!(status["plan"]["content"], "Versioned architecture");
}

#[test]
fn completion_and_abort_fail_closed_without_required_evidence() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = GoalId::new();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Create {
            constraints: vec![],
            goal_id,
            max_continuations: 5,
            non_goals: vec![],
            objective: "Build a production SaaS".to_owned(),
            session_id: "session".to_owned(),
            success_criteria: vec![],
        },
    )
    .unwrap();

    assert!(
        workflowd::goal::execute(
            &mut store,
            &key,
            "project",
            GoalOperation::Control {
                action: GoalControlAction::ApproveCompletion,
                completion_evidence: None,
                goal_id,
                operation_id: ReceiptId::new(),
                reason: None,
            },
        )
        .is_err()
    );
    assert!(
        workflowd::goal::execute(
            &mut store,
            &key,
            "project",
            GoalOperation::Control {
                action: GoalControlAction::Abort,
                completion_evidence: None,
                goal_id,
                operation_id: ReceiptId::new(),
                reason: None,
            },
        )
        .is_err()
    );
}

#[test]
fn completed_milestone_supersedes_cancelled_attempts() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = GoalId::new();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Create {
            constraints: vec![],
            goal_id,
            max_continuations: 5,
            non_goals: vec![],
            objective: "Deliver one milestone".to_owned(),
            session_id: "session".to_owned(),
            success_criteria: vec!["The milestone is complete".to_owned()],
        },
    )
    .unwrap();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::SavePlan {
            content: "Milestone plan".to_owned(),
            goal_id,
            source_session_id: "architect".to_owned(),
        },
    )
    .unwrap();
    for action in [GoalControlAction::MarkReady, GoalControlAction::Activate] {
        workflowd::goal::execute(
            &mut store,
            &key,
            "project",
            GoalOperation::Control {
                action,
                completion_evidence: None,
                goal_id,
                operation_id: ReceiptId::new(),
                reason: None,
            },
        )
        .unwrap();
    }

    let timestamp = WorkflowTimestamp::now();
    let cancelled = WorkflowId::new();
    store
        .apply_workflow_command(
            cancelled,
            "cancelled-intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            cancelled,
            "cancelled-route",
            WorkflowCommand::Route(WorkflowMode::Quick),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(cancelled, "cancelled", WorkflowCommand::Cancel, timestamp)
        .unwrap();
    store
        .link_goal_workflow(goal_id, cancelled, "release", timestamp)
        .unwrap();

    let completed = WorkflowId::new();
    for (key, command) in [
        ("completed-intake", WorkflowCommand::CompleteIntake),
        (
            "completed-route",
            WorkflowCommand::Route(WorkflowMode::Quick),
        ),
        (
            "completed-candidate",
            WorkflowCommand::CandidateReady(CandidateId::new()),
        ),
        (
            "completed-verification",
            WorkflowCommand::VerificationPassed,
        ),
        (
            "completed-approval",
            WorkflowCommand::Approve {
                mandatory_gates_passed: true,
            },
        ),
        ("completed-delivery", WorkflowCommand::Deliver),
    ] {
        store
            .apply_workflow_command(completed, key, command, timestamp)
            .unwrap();
    }
    store
        .link_goal_workflow(goal_id, completed, "release", timestamp)
        .unwrap();

    let result = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Control {
            action: GoalControlAction::RequestCompletion,
            completion_evidence: None,
            goal_id,
            operation_id: ReceiptId::new(),
            reason: None,
        },
    )
    .unwrap();

    assert_eq!(result["state"], "completing");
}
