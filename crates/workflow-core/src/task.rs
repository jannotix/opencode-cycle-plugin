use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Ready,
    Leased,
    Running,
    Verifying,
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

impl TaskState {
    pub const ALL: [Self; 9] = [
        Self::Pending,
        Self::Ready,
        Self::Leased,
        Self::Running,
        Self::Verifying,
        Self::Completed,
        Self::Failed,
        Self::Blocked,
        Self::Cancelled,
    ];

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskCommand {
    DependenciesSatisfied,
    Lease,
    Start,
    SubmitCandidate,
    VerificationPassed { mandatory_gates_passed: bool },
    VerificationFailed { retryable: bool },
    Block,
    Unblock,
    Cancel,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskEvent {
    StateChanged { from: TaskState, to: TaskState },
    AttemptStarted { attempt: u32 },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Task {
    state: TaskState,
    attempts: u32,
}

impl Default for Task {
    fn default() -> Self {
        Self::new()
    }
}

impl Task {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: TaskState::Pending,
            attempts: 0,
        }
    }

    #[must_use]
    pub const fn state(&self) -> TaskState {
        self.state
    }

    #[must_use]
    pub const fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn apply(
        &mut self,
        command: TaskCommand,
    ) -> Result<Vec<TaskEvent>, crate::TransitionError> {
        match command {
            TaskCommand::DependenciesSatisfied if self.state == TaskState::Pending => {
                Ok(self.transition(TaskState::Ready))
            }
            TaskCommand::Lease if self.state == TaskState::Ready => {
                Ok(self.transition(TaskState::Leased))
            }
            TaskCommand::Start if self.state == TaskState::Leased => {
                self.attempts = self.attempts.saturating_add(1);
                let mut events = vec![TaskEvent::AttemptStarted {
                    attempt: self.attempts,
                }];
                events.extend(self.transition(TaskState::Running));
                Ok(events)
            }
            TaskCommand::SubmitCandidate if self.state == TaskState::Running => {
                Ok(self.transition(TaskState::Verifying))
            }
            TaskCommand::VerificationPassed {
                mandatory_gates_passed,
            } if self.state == TaskState::Verifying => {
                if !mandatory_gates_passed {
                    return Err(crate::TransitionError::MandatoryGateFailed);
                }
                Ok(self.transition(TaskState::Completed))
            }
            TaskCommand::VerificationFailed { retryable } if self.state == TaskState::Verifying => {
                Ok(self.transition(if retryable {
                    TaskState::Ready
                } else {
                    TaskState::Failed
                }))
            }
            TaskCommand::Block if !self.state.is_terminal() && self.state != TaskState::Blocked => {
                Ok(self.transition(TaskState::Blocked))
            }
            TaskCommand::Unblock if self.state == TaskState::Blocked => {
                Ok(self.transition(TaskState::Ready))
            }
            TaskCommand::Cancel if !self.state.is_terminal() => {
                Ok(self.transition(TaskState::Cancelled))
            }
            _ => Err(crate::TransitionError::InvalidTransition),
        }
    }

    fn transition(&mut self, to: TaskState) -> Vec<TaskEvent> {
        let from = self.state;
        self.state = to;
        vec![TaskEvent::StateChanged { from, to }]
    }
}
