use std::num::NonZeroU8;

use workflow_core::{Goal, GoalCommand, GoalError, GoalState, WorkflowTimestamp};

fn goal() -> Goal {
    Goal::new(
        "Deliver a production SaaS".to_owned(),
        vec!["A verified user can complete the primary journey".to_owned()],
        vec!["Use stable dependencies".to_owned()],
        vec!["No native mobile application".to_owned()],
        NonZeroU8::new(5).unwrap(),
    )
    .unwrap()
}

#[test]
fn goal_preserves_objective_and_user_amendments() {
    let mut goal = goal();
    let original = goal.objective_digest();
    goal.append_amendment(
        "Add organization-level tenancy".to_owned(),
        WorkflowTimestamp::now(),
    )
    .unwrap();

    assert_eq!(goal.objective(), "Deliver a production SaaS");
    assert_eq!(goal.objective_digest(), original);
    assert_eq!(goal.amendments().len(), 1);
    assert_ne!(goal.request_digest(), original);
}

#[test]
fn goal_lifecycle_requires_audited_completion() {
    let mut goal = goal();
    goal.apply(GoalCommand::StartPlanning).unwrap();
    goal.apply(GoalCommand::MarkReady).unwrap();
    goal.apply(GoalCommand::Activate).unwrap();
    goal.apply(GoalCommand::RequestCompletion).unwrap();

    assert_eq!(goal.state(), GoalState::Completing);
    assert!(matches!(
        goal.apply(GoalCommand::Activate),
        Err(GoalError::InvalidTransition)
    ));
    goal.apply(GoalCommand::ApproveCompletion).unwrap();
    assert_eq!(goal.state(), GoalState::Completed);
}

#[test]
fn continuation_cap_blocks_runaway_goals() {
    let mut goal = goal();
    goal.apply(GoalCommand::StartPlanning).unwrap();
    goal.apply(GoalCommand::MarkReady).unwrap();
    goal.apply(GoalCommand::Activate).unwrap();
    for _ in 0..4 {
        goal.apply(GoalCommand::Continue).unwrap();
    }
    let events = goal.apply(GoalCommand::Continue).unwrap();

    assert_eq!(goal.state(), GoalState::Blocked);
    assert_eq!(goal.continuations(), 5);
    assert!(events.iter().any(|event| matches!(
        event,
        workflow_core::GoalEvent::ContinuationLimitReached { maximum: 5 }
    )));
}

#[test]
fn invalid_or_unbounded_goal_input_fails_closed() {
    assert!(matches!(
        Goal::new(
            " ".to_owned(),
            vec![],
            vec![],
            vec![],
            NonZeroU8::new(5).unwrap()
        ),
        Err(GoalError::InvalidObjective)
    ));
    assert!(matches!(
        Goal::new(
            "valid".to_owned(),
            vec!["x".repeat(4097)],
            vec![],
            vec![],
            NonZeroU8::new(5).unwrap()
        ),
        Err(GoalError::InvalidField)
    ));
}
