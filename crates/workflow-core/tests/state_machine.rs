use workflow_core::{
    CandidateId, RepairTarget, Task, TaskCommand, TaskState, Workflow, WorkflowCommand,
    WorkflowMode, WorkflowState,
};

fn candidate() -> CandidateId {
    CandidateId::new()
}

#[test]
fn quick_workflow_requires_verified_arbitration() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Quick))
        .unwrap();
    workflow
        .apply(WorkflowCommand::CandidateReady(candidate()))
        .unwrap();
    workflow.apply(WorkflowCommand::VerificationPassed).unwrap();

    assert_eq!(workflow.state(), WorkflowState::Arbitration);
    assert!(
        workflow
            .apply(WorkflowCommand::Approve {
                mandatory_gates_passed: false,
            })
            .is_err()
    );
    assert_eq!(workflow.state(), WorkflowState::Arbitration);

    workflow
        .apply(WorkflowCommand::Approve {
            mandatory_gates_passed: true,
        })
        .unwrap();
    assert_eq!(workflow.state(), WorkflowState::Delivery);
    workflow.apply(WorkflowCommand::Deliver).unwrap();
    assert_eq!(workflow.state(), WorkflowState::Completed);
}

#[test]
fn full_workflow_passes_both_review_stages() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Full))
        .unwrap();
    workflow
        .apply(WorkflowCommand::ArchitectureAccepted)
        .unwrap();
    workflow
        .apply(WorkflowCommand::CandidateReady(candidate()))
        .unwrap();
    workflow.apply(WorkflowCommand::VerificationPassed).unwrap();
    assert_eq!(workflow.state(), WorkflowState::IndependentReviews);
    workflow.apply(WorkflowCommand::ReviewsReady).unwrap();
    assert_eq!(workflow.state(), WorkflowState::Arbitration);
}

#[test]
fn fifth_rejected_candidate_blocks_without_counting_infrastructure_retries() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Quick))
        .unwrap();

    for cycle in 1..=5 {
        workflow
            .apply(WorkflowCommand::RetryInfrastructure)
            .unwrap();
        workflow
            .apply(WorkflowCommand::CandidateReady(candidate()))
            .unwrap();
        workflow.apply(WorkflowCommand::VerificationPassed).unwrap();
        workflow
            .apply(WorkflowCommand::Reject(RepairTarget::Execution))
            .unwrap();
        assert_eq!(workflow.repair_cycles(), cycle);

        if cycle < 5 {
            assert_eq!(workflow.state(), WorkflowState::Repair);
            workflow.apply(WorkflowCommand::BeginRepair).unwrap();
        }
    }

    assert_eq!(workflow.state(), WorkflowState::Blocked);
    workflow
        .apply(WorkflowCommand::ResumeBlocked {
            additional_cycles: 2,
        })
        .unwrap();
    assert_eq!(workflow.state(), WorkflowState::Repair);
    assert_eq!(workflow.max_repair_cycles(), 7);
}

#[test]
fn pause_and_resume_restore_the_exact_active_state() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Full))
        .unwrap();
    workflow.apply(WorkflowCommand::Pause).unwrap();
    assert_eq!(workflow.state(), WorkflowState::Paused);
    workflow.apply(WorkflowCommand::Resume).unwrap();
    assert_eq!(workflow.state(), WorkflowState::Architecture);
}

#[test]
fn infrastructure_block_is_recoverable_without_extending_repair_budget() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Quick))
        .unwrap();
    workflow
        .apply(WorkflowCommand::CandidateReady(candidate()))
        .unwrap();
    workflow
        .apply(WorkflowCommand::BlockInfrastructure)
        .unwrap();
    assert_eq!(workflow.state(), WorkflowState::Blocked);
    assert_eq!(workflow.repair_cycles(), 0);
    assert!(
        workflow
            .apply(WorkflowCommand::ResumeBlocked {
                additional_cycles: 1,
            })
            .is_err()
    );
    workflow
        .apply(WorkflowCommand::ResumeInfrastructure)
        .unwrap();
    assert_eq!(workflow.state(), WorkflowState::Verification);
    assert_eq!(workflow.repair_cycles(), 0);
}

#[test]
fn atomic_verification_and_delivery_phases_reject_user_pause() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Quick))
        .unwrap();
    workflow
        .apply(WorkflowCommand::CandidateReady(candidate()))
        .unwrap();
    assert!(workflow.apply(WorkflowCommand::Pause).is_err());
    assert_eq!(workflow.state(), WorkflowState::Verification);

    workflow.apply(WorkflowCommand::VerificationPassed).unwrap();
    workflow
        .apply(WorkflowCommand::Approve {
            mandatory_gates_passed: true,
        })
        .unwrap();
    assert!(workflow.apply(WorkflowCommand::Pause).is_err());
    assert_eq!(workflow.state(), WorkflowState::Delivery);
}

#[test]
fn invalid_workflow_transition_is_transactional() {
    let mut workflow = Workflow::default();
    let before = workflow.clone();
    assert!(
        workflow
            .apply(WorkflowCommand::Approve {
                mandatory_gates_passed: true,
            })
            .is_err()
    );
    assert_eq!(workflow, before);
}

#[test]
fn task_completion_requires_successful_mandatory_verification_and_reviewer_approval() {
    for (mandatory_gates_passed, reviewer_approved, completes) in [
        (false, false, false),
        (false, true, false),
        (true, false, false),
        (true, true, true),
    ] {
        let mut task = Task::new();
        task.apply(TaskCommand::DependenciesSatisfied).unwrap();
        task.apply(TaskCommand::Lease).unwrap();
        task.apply(TaskCommand::Start).unwrap();
        task.apply(TaskCommand::SubmitCandidate).unwrap();
        let result = task.apply(TaskCommand::VerificationPassed {
            mandatory_gates_passed,
            reviewer_approved,
        });
        if completes {
            assert!(result.is_ok());
            assert_eq!(task.state(), TaskState::Completed);
        } else {
            assert!(result.is_err());
            assert_eq!(task.state(), TaskState::Verifying);
        }
    }
}

#[test]
fn execution_replan_consumes_an_architecture_repair_cycle() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Full))
        .unwrap();
    workflow
        .apply(WorkflowCommand::ArchitectureAccepted)
        .unwrap();

    let events = workflow.apply(WorkflowCommand::ReplanExecution).unwrap();
    assert_eq!(workflow.state(), WorkflowState::Repair);
    assert_eq!(workflow.repair_cycles(), 1);
    assert!(events.iter().any(|event| matches!(
        event,
        workflow_core::WorkflowEvent::RepairCycleConsumed {
            cycle: 1,
            maximum: 5
        }
    )));
    workflow.apply(WorkflowCommand::BeginRepair).unwrap();
    assert_eq!(workflow.state(), WorkflowState::Architecture);
}

#[test]
fn execution_replan_exhausts_the_same_bounded_repair_budget() {
    let mut workflow = Workflow::default();
    workflow.apply(WorkflowCommand::CompleteIntake).unwrap();
    workflow
        .apply(WorkflowCommand::Route(WorkflowMode::Full))
        .unwrap();
    workflow
        .apply(WorkflowCommand::ArchitectureAccepted)
        .unwrap();

    for cycle in 1..=5 {
        workflow.apply(WorkflowCommand::ReplanExecution).unwrap();
        assert_eq!(workflow.repair_cycles(), cycle);
        if cycle < 5 {
            assert_eq!(workflow.state(), WorkflowState::Repair);
            workflow.apply(WorkflowCommand::BeginRepair).unwrap();
            workflow
                .apply(WorkflowCommand::ArchitectureAccepted)
                .unwrap();
        }
    }
    assert_eq!(workflow.state(), WorkflowState::Blocked);
}

#[test]
fn completed_task_reopens_only_through_an_explicit_repair_command() {
    let mut task = Task::new();
    for command in [
        TaskCommand::DependenciesSatisfied,
        TaskCommand::Lease,
        TaskCommand::Start,
        TaskCommand::SubmitCandidate,
        TaskCommand::VerificationPassed {
            mandatory_gates_passed: true,
            reviewer_approved: true,
        },
    ] {
        task.apply(command).unwrap();
    }
    assert_eq!(task.state(), TaskState::Completed);
    assert!(task.apply(TaskCommand::Lease).is_err());
    task.apply(TaskCommand::RepairRequested).unwrap();
    assert_eq!(task.state(), TaskState::Ready);
}
