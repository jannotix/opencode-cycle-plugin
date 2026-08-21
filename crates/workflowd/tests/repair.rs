use std::num::NonZeroUsize;

use workflow_core::{
    CandidateId, WorkflowCommand, WorkflowId, WorkflowMode, WorkflowState, WorkflowTimestamp,
};
use workflow_store::Store;
use workflowd::repair::{RepairCause, route};

fn execution(store: &mut Store, workflow_id: WorkflowId) {
    let timestamp = WorkflowTimestamp::now();
    for (key, command) in [
        ("intake", WorkflowCommand::CompleteIntake),
        ("route", WorkflowCommand::Route(WorkflowMode::Full)),
        ("architecture", WorkflowCommand::ArchitectureAccepted),
    ] {
        store
            .apply_workflow_command(workflow_id, key, command, timestamp)
            .unwrap();
    }
}

fn arbitration(store: &mut Store, workflow_id: WorkflowId, candidate_id: CandidateId) {
    let timestamp = WorkflowTimestamp::now();
    store
        .apply_workflow_command(
            workflow_id,
            &format!("candidate-{candidate_id}"),
            WorkflowCommand::CandidateReady(candidate_id),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            &format!("verified-{candidate_id}"),
            WorkflowCommand::VerificationPassed,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            workflow_id,
            &format!("reviewed-{candidate_id}"),
            WorkflowCommand::ReviewsReady,
            timestamp,
        )
        .unwrap();
}

#[test]
fn fifth_real_rejection_blocks_while_new_candidates_rerun_verification() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    execution(&mut store, workflow_id);

    for cycle in 1..=5 {
        let candidate_id = CandidateId::new();
        arbitration(&mut store, workflow_id, candidate_id);
        let outcome = route(
            &mut store,
            workflow_id,
            candidate_id,
            RepairCause::ImplementationFinding,
            WorkflowTimestamp::now(),
        )
        .unwrap();
        assert_eq!(outcome.cycles, cycle);
        assert_eq!(
            outcome.state,
            if cycle == 5 {
                WorkflowState::Blocked
            } else {
                WorkflowState::Execution
            }
        );
    }
}

#[test]
fn plan_defects_return_to_architecture_and_infrastructure_does_not_consume_a_cycle() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    execution(&mut store, workflow_id);
    let candidate_id = CandidateId::new();
    arbitration(&mut store, workflow_id, candidate_id);

    let retry = route(
        &mut store,
        workflow_id,
        candidate_id,
        RepairCause::InfrastructureFailure,
        WorkflowTimestamp::now(),
    )
    .unwrap();
    assert_eq!(retry.cycles, 0);
    assert_eq!(retry.state, WorkflowState::Arbitration);
    let repair = route(
        &mut store,
        workflow_id,
        candidate_id,
        RepairCause::PlanDefect,
        WorkflowTimestamp::now(),
    )
    .unwrap();
    assert_eq!(repair.cycles, 1);
    assert_eq!(repair.state, WorkflowState::Architecture);
}
