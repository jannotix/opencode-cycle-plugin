use workflow_core::{
    CandidateId, RepairTarget, WorkflowCommand, WorkflowId, WorkflowState, WorkflowTimestamp,
};
use workflow_store::{Store, StoreError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepairCause {
    ImplementationFinding,
    InfrastructureFailure,
    PlanDefect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RepairOutcome {
    pub cycles: u8,
    pub maximum: u8,
    pub state: WorkflowState,
}

pub fn route(
    store: &mut Store,
    workflow_id: WorkflowId,
    candidate_id: CandidateId,
    cause: RepairCause,
    timestamp: WorkflowTimestamp,
) -> Result<RepairOutcome, StoreError> {
    let current = store
        .load_workflow(workflow_id)?
        .ok_or(StoreError::AggregateConflict)?;
    if current.current_candidate() != Some(candidate_id) {
        return Err(StoreError::AggregateConflict);
    }
    if cause == RepairCause::InfrastructureFailure {
        let state = store
            .apply_workflow_command(
                workflow_id,
                &format!("{workflow_id}:{candidate_id}:infrastructure-retry"),
                WorkflowCommand::RetryInfrastructure,
                timestamp,
            )?
            .state;
        return Ok(outcome(&state));
    }
    let target = match cause {
        RepairCause::ImplementationFinding => RepairTarget::Execution,
        RepairCause::PlanDefect => RepairTarget::Architecture,
        RepairCause::InfrastructureFailure => unreachable!(),
    };
    let command = match current.state() {
        WorkflowState::Verification => WorkflowCommand::VerificationRejected(target),
        WorkflowState::Arbitration => WorkflowCommand::Reject(target),
        _ => {
            return Err(StoreError::Transition(
                workflow_core::TransitionError::InvalidTransition,
            ));
        }
    };
    let rejected = store
        .apply_workflow_command(
            workflow_id,
            &format!("{workflow_id}:{candidate_id}:reject:{target:?}"),
            command,
            timestamp,
        )?
        .state;
    if rejected.state() == WorkflowState::Repair {
        let repairing = store
            .apply_workflow_command(
                workflow_id,
                &format!(
                    "{workflow_id}:{candidate_id}:begin-repair:{}",
                    rejected.repair_cycles()
                ),
                WorkflowCommand::BeginRepair,
                timestamp,
            )?
            .state;
        Ok(outcome(&repairing))
    } else {
        Ok(outcome(&rejected))
    }
}

const fn outcome(workflow: &workflow_core::Workflow) -> RepairOutcome {
    RepairOutcome {
        cycles: workflow.repair_cycles(),
        maximum: workflow.max_repair_cycles(),
        state: workflow.state(),
    }
}
