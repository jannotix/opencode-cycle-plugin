use std::num::NonZeroU8;

use serde::{Deserialize, Serialize};

use crate::CandidateId;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowMode {
    Quick,
    Full,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RepairTarget {
    Execution,
    Architecture,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowState {
    Intake,
    Routing,
    QuickExecution,
    Architecture,
    Execution,
    Verification,
    IndependentReviews,
    Arbitration,
    Delivery,
    Repair,
    Paused,
    Blocked,
    Completed,
    Cancelled,
}

impl WorkflowState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkflowCommand {
    CompleteIntake,
    Route(WorkflowMode),
    ArchitectureAccepted,
    CandidateReady(CandidateId),
    VerificationPassed,
    VerificationFailed,
    VerificationRejected(RepairTarget),
    ReviewsReady,
    Approve { mandatory_gates_passed: bool },
    Deliver,
    Reject(RepairTarget),
    BeginRepair,
    Pause,
    Resume,
    Cancel,
    RetryInfrastructure,
    ResumeBlocked { additional_cycles: u8 },
    BlockInfrastructure,
    ResumeInfrastructure,
    ReplanExecution,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowEvent {
    StateChanged {
        from: WorkflowState,
        to: WorkflowState,
    },
    CandidateSelected {
        candidate_id: CandidateId,
    },
    RepairCycleConsumed {
        cycle: u8,
        maximum: u8,
    },
    RepairBudgetExtended {
        previous: u8,
        current: u8,
    },
    InfrastructureRetryAccepted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransitionError {
    InvalidTransition,
    MandatoryGateFailed,
    MissingCandidate,
    MissingRepairTarget,
    InvalidAdditionalCycles,
    RepairBudgetOverflow,
}

impl std::fmt::Display for TransitionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidTransition => "the command is not valid in the current workflow state",
            Self::MandatoryGateFailed => "mandatory gates have not passed",
            Self::MissingCandidate => "the workflow has no current candidate",
            Self::MissingRepairTarget => "the workflow has no repair target",
            Self::InvalidAdditionalCycles => "additional repair cycles must be greater than zero",
            Self::RepairBudgetOverflow => "the repair cycle limit exceeds the supported range",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TransitionError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Workflow {
    state: WorkflowState,
    mode: Option<WorkflowMode>,
    current_candidate: Option<CandidateId>,
    repair_target: Option<RepairTarget>,
    repair_cycles: u8,
    max_repair_cycles: u8,
    paused_from: Option<WorkflowState>,
    #[serde(default)]
    infrastructure_blocked_from: Option<WorkflowState>,
}

impl Default for Workflow {
    fn default() -> Self {
        Self::new(NonZeroU8::new(5).expect("five is non-zero"))
    }
}

impl Workflow {
    #[must_use]
    pub const fn new(max_repair_cycles: NonZeroU8) -> Self {
        Self {
            state: WorkflowState::Intake,
            mode: None,
            current_candidate: None,
            repair_target: None,
            repair_cycles: 0,
            max_repair_cycles: max_repair_cycles.get(),
            paused_from: None,
            infrastructure_blocked_from: None,
        }
    }

    #[must_use]
    pub const fn state(&self) -> WorkflowState {
        self.state
    }

    #[must_use]
    pub const fn mode(&self) -> Option<WorkflowMode> {
        self.mode
    }

    #[must_use]
    pub const fn repair_cycles(&self) -> u8 {
        self.repair_cycles
    }

    #[must_use]
    pub const fn max_repair_cycles(&self) -> u8 {
        self.max_repair_cycles
    }

    #[must_use]
    pub const fn current_candidate(&self) -> Option<CandidateId> {
        self.current_candidate
    }

    pub fn apply(
        &mut self,
        command: WorkflowCommand,
    ) -> Result<Vec<WorkflowEvent>, TransitionError> {
        match command {
            WorkflowCommand::CompleteIntake if self.state == WorkflowState::Intake => {
                Ok(self.transition(WorkflowState::Routing))
            }
            WorkflowCommand::Route(mode) if self.state == WorkflowState::Routing => {
                self.mode = Some(mode);
                Ok(self.transition(match mode {
                    WorkflowMode::Quick => WorkflowState::QuickExecution,
                    WorkflowMode::Full => WorkflowState::Architecture,
                }))
            }
            WorkflowCommand::ArchitectureAccepted if self.state == WorkflowState::Architecture => {
                Ok(self.transition(WorkflowState::Execution))
            }
            WorkflowCommand::CandidateReady(candidate_id)
                if matches!(
                    self.state,
                    WorkflowState::QuickExecution | WorkflowState::Execution
                ) =>
            {
                self.current_candidate = Some(candidate_id);
                let mut events = vec![WorkflowEvent::CandidateSelected { candidate_id }];
                events.extend(self.transition(WorkflowState::Verification));
                Ok(events)
            }
            WorkflowCommand::VerificationPassed if self.state == WorkflowState::Verification => {
                self.require_candidate()?;
                let next = match self.mode {
                    Some(WorkflowMode::Quick) => WorkflowState::Arbitration,
                    Some(WorkflowMode::Full) => WorkflowState::IndependentReviews,
                    None => return Err(TransitionError::InvalidTransition),
                };
                Ok(self.transition(next))
            }
            WorkflowCommand::VerificationFailed if self.state == WorkflowState::Verification => {
                self.require_candidate()?;
                self.reject(RepairTarget::Execution)
            }
            WorkflowCommand::VerificationRejected(target)
                if self.state == WorkflowState::Verification =>
            {
                self.require_candidate()?;
                self.reject(target)
            }
            WorkflowCommand::ReviewsReady if self.state == WorkflowState::IndependentReviews => {
                Ok(self.transition(WorkflowState::Arbitration))
            }
            WorkflowCommand::Approve {
                mandatory_gates_passed,
            } if self.state == WorkflowState::Arbitration => {
                self.require_candidate()?;
                if !mandatory_gates_passed {
                    return Err(TransitionError::MandatoryGateFailed);
                }
                Ok(self.transition(WorkflowState::Delivery))
            }
            WorkflowCommand::Deliver if self.state == WorkflowState::Delivery => {
                self.require_candidate()?;
                Ok(self.transition(WorkflowState::Completed))
            }
            WorkflowCommand::Reject(target) if self.state == WorkflowState::Arbitration => {
                self.require_candidate()?;
                self.reject(target)
            }
            WorkflowCommand::BeginRepair if self.state == WorkflowState::Repair => {
                let target = self
                    .repair_target
                    .take()
                    .ok_or(TransitionError::MissingRepairTarget)?;
                self.current_candidate = None;
                Ok(self.transition(match target {
                    RepairTarget::Execution => WorkflowState::Execution,
                    RepairTarget::Architecture => WorkflowState::Architecture,
                }))
            }
            WorkflowCommand::Pause if self.can_pause() => {
                self.paused_from = Some(self.state);
                Ok(self.transition(WorkflowState::Paused))
            }
            WorkflowCommand::Resume if self.state == WorkflowState::Paused => {
                let previous = self
                    .paused_from
                    .take()
                    .ok_or(TransitionError::InvalidTransition)?;
                Ok(self.transition(previous))
            }
            WorkflowCommand::Cancel if !self.state.is_terminal() => {
                self.paused_from = None;
                Ok(self.transition(WorkflowState::Cancelled))
            }
            WorkflowCommand::RetryInfrastructure if self.can_retry_infrastructure() => {
                Ok(vec![WorkflowEvent::InfrastructureRetryAccepted])
            }
            WorkflowCommand::ResumeBlocked { additional_cycles }
                if self.state == WorkflowState::Blocked
                    && self.infrastructure_blocked_from.is_none() =>
            {
                if additional_cycles == 0 {
                    return Err(TransitionError::InvalidAdditionalCycles);
                }
                let previous = self.max_repair_cycles;
                self.max_repair_cycles = previous
                    .checked_add(additional_cycles)
                    .ok_or(TransitionError::RepairBudgetOverflow)?;
                let mut events = vec![WorkflowEvent::RepairBudgetExtended {
                    previous,
                    current: self.max_repair_cycles,
                }];
                events.extend(self.transition(WorkflowState::Repair));
                Ok(events)
            }
            WorkflowCommand::BlockInfrastructure if self.can_block_infrastructure() => {
                self.infrastructure_blocked_from = Some(self.state);
                Ok(self.transition(WorkflowState::Blocked))
            }
            WorkflowCommand::ResumeInfrastructure
                if self.state == WorkflowState::Blocked
                    && self.infrastructure_blocked_from.is_some() =>
            {
                let previous = self
                    .infrastructure_blocked_from
                    .take()
                    .ok_or(TransitionError::InvalidTransition)?;
                Ok(self.transition(previous))
            }
            WorkflowCommand::ReplanExecution if self.state == WorkflowState::Execution => {
                Ok(self.transition(WorkflowState::Architecture))
            }
            _ => Err(TransitionError::InvalidTransition),
        }
    }

    fn reject(&mut self, target: RepairTarget) -> Result<Vec<WorkflowEvent>, TransitionError> {
        let next_cycle = self
            .repair_cycles
            .checked_add(1)
            .ok_or(TransitionError::RepairBudgetOverflow)?;
        self.repair_cycles = next_cycle;
        self.repair_target = Some(target);
        let mut events = vec![WorkflowEvent::RepairCycleConsumed {
            cycle: next_cycle,
            maximum: self.max_repair_cycles,
        }];
        events.extend(self.transition(if next_cycle >= self.max_repair_cycles {
            WorkflowState::Blocked
        } else {
            WorkflowState::Repair
        }));
        Ok(events)
    }

    fn require_candidate(&self) -> Result<CandidateId, TransitionError> {
        self.current_candidate
            .ok_or(TransitionError::MissingCandidate)
    }

    fn transition(&mut self, to: WorkflowState) -> Vec<WorkflowEvent> {
        let from = self.state;
        self.state = to;
        vec![WorkflowEvent::StateChanged { from, to }]
    }

    const fn can_pause(&self) -> bool {
        !matches!(
            self.state,
            WorkflowState::Paused
                | WorkflowState::Blocked
                | WorkflowState::Verification
                | WorkflowState::Delivery
                | WorkflowState::Completed
                | WorkflowState::Cancelled
        )
    }

    const fn can_retry_infrastructure(&self) -> bool {
        !matches!(
            self.state,
            WorkflowState::Paused
                | WorkflowState::Blocked
                | WorkflowState::Completed
                | WorkflowState::Cancelled
        )
    }

    const fn can_block_infrastructure(&self) -> bool {
        !matches!(
            self.state,
            WorkflowState::Paused
                | WorkflowState::Blocked
                | WorkflowState::Completed
                | WorkflowState::Cancelled
        )
    }
}
