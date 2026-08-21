use workflow_core::{
    CandidateId, RepairTarget, Task, TaskCommand, TaskState, Workflow, WorkflowCommand,
    WorkflowMode,
};

fn terminal_workflows() -> [Workflow; 2] {
    let mut completed = Workflow::default();
    completed.apply(WorkflowCommand::CompleteIntake).unwrap();
    completed
        .apply(WorkflowCommand::Route(WorkflowMode::Quick))
        .unwrap();
    completed
        .apply(WorkflowCommand::CandidateReady(CandidateId::new()))
        .unwrap();
    completed
        .apply(WorkflowCommand::VerificationPassed)
        .unwrap();
    completed
        .apply(WorkflowCommand::Approve {
            mandatory_gates_passed: true,
        })
        .unwrap();
    completed.apply(WorkflowCommand::Deliver).unwrap();

    let mut cancelled = Workflow::default();
    cancelled.apply(WorkflowCommand::Cancel).unwrap();
    [completed, cancelled]
}

fn task_in_state(state: TaskState) -> Task {
    let mut task = Task::new();
    if state == TaskState::Pending {
        return task;
    }
    if state == TaskState::Blocked {
        task.apply(TaskCommand::Block).unwrap();
        return task;
    }
    if state == TaskState::Cancelled {
        task.apply(TaskCommand::Cancel).unwrap();
        return task;
    }

    task.apply(TaskCommand::DependenciesSatisfied).unwrap();
    if state == TaskState::Ready {
        return task;
    }
    task.apply(TaskCommand::Lease).unwrap();
    if state == TaskState::Leased {
        return task;
    }
    task.apply(TaskCommand::Start).unwrap();
    if state == TaskState::Running {
        return task;
    }
    task.apply(TaskCommand::SubmitCandidate).unwrap();
    if state == TaskState::Verifying {
        return task;
    }
    if state == TaskState::Completed {
        task.apply(TaskCommand::VerificationPassed {
            mandatory_gates_passed: true,
        })
        .unwrap();
    } else if state == TaskState::Failed {
        task.apply(TaskCommand::VerificationFailed { retryable: false })
            .unwrap();
    }
    task
}

#[test]
fn terminal_workflow_states_reject_every_command_without_mutation() {
    let commands = [
        WorkflowCommand::CompleteIntake,
        WorkflowCommand::Route(WorkflowMode::Quick),
        WorkflowCommand::ArchitectureAccepted,
        WorkflowCommand::CandidateReady(CandidateId::new()),
        WorkflowCommand::VerificationPassed,
        WorkflowCommand::VerificationFailed,
        WorkflowCommand::ReviewsReady,
        WorkflowCommand::Approve {
            mandatory_gates_passed: true,
        },
        WorkflowCommand::Deliver,
        WorkflowCommand::Reject(RepairTarget::Execution),
        WorkflowCommand::BeginRepair,
        WorkflowCommand::Pause,
        WorkflowCommand::Resume,
        WorkflowCommand::Cancel,
        WorkflowCommand::RetryInfrastructure,
        WorkflowCommand::ResumeBlocked {
            additional_cycles: 1,
        },
    ];

    for mut workflow in terminal_workflows() {
        let terminal = workflow.state();
        for command in commands {
            let before = workflow.clone();
            assert!(workflow.apply(command).is_err());
            assert_eq!(workflow, before);
            assert_eq!(workflow.state(), terminal);
        }
    }
}

#[test]
fn every_forbidden_task_transition_preserves_state() {
    let commands = [
        TaskCommand::DependenciesSatisfied,
        TaskCommand::Lease,
        TaskCommand::Start,
        TaskCommand::SubmitCandidate,
        TaskCommand::VerificationPassed {
            mandatory_gates_passed: true,
        },
        TaskCommand::VerificationFailed { retryable: true },
        TaskCommand::Block,
        TaskCommand::Unblock,
        TaskCommand::Cancel,
    ];

    for state in TaskState::ALL {
        for command in commands {
            let mut task = task_in_state(state);
            let before = task.clone();
            if task.apply(command).is_err() {
                assert_eq!(task, before);
            }
        }
    }
}
