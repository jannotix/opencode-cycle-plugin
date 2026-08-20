use std::num::NonZeroU8;

use serde::{Deserialize, Serialize};

use crate::{ContentDigest, RequestAmendment, RequestError, RequestRecord, WorkflowTimestamp};

const MAX_ITEMS: usize = 256;
const MAX_OBJECTIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 4_096;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalState {
    Draft,
    Planning,
    Ready,
    Active,
    Paused,
    Blocked,
    Completing,
    Completed,
    Aborted,
}

impl GoalState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Aborted)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalCommand {
    StartPlanning,
    MarkReady,
    Activate,
    Pause,
    Resume,
    Block,
    ResumeBlocked,
    Continue,
    RequestCompletion,
    ApproveCompletion,
    RejectCompletion,
    Abort,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GoalEvent {
    StateChanged { from: GoalState, to: GoalState },
    ContinuationRecorded { current: u8, maximum: u8 },
    ContinuationLimitReached { maximum: u8 },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Goal {
    request: RequestRecord,
    success_criteria: Vec<String>,
    constraints: Vec<String>,
    non_goals: Vec<String>,
    state: GoalState,
    max_continuations: u8,
    continuations: u8,
    paused_from: Option<GoalState>,
    blocked_from: Option<GoalState>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UncheckedGoal {
    request: RequestRecord,
    success_criteria: Vec<String>,
    constraints: Vec<String>,
    non_goals: Vec<String>,
    state: GoalState,
    max_continuations: u8,
    continuations: u8,
    paused_from: Option<GoalState>,
    blocked_from: Option<GoalState>,
}

#[derive(Debug)]
pub enum GoalError {
    InvalidObjective,
    InvalidField,
    InvalidTransition,
    Request(RequestError),
}

impl std::fmt::Display for GoalError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidObjective => {
                formatter.write_str("goal objective must be bounded non-empty text")
            }
            Self::InvalidField => {
                formatter.write_str("goal fields must contain bounded non-empty text")
            }
            Self::InvalidTransition => {
                formatter.write_str("the command is not valid in the current goal state")
            }
            Self::Request(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for GoalError {}

impl TryFrom<UncheckedGoal> for Goal {
    type Error = GoalError;

    fn try_from(value: UncheckedGoal) -> Result<Self, Self::Error> {
        validate_objective(value.request.original_text())?;
        validate_items(&value.success_criteria)?;
        validate_items(&value.constraints)?;
        validate_items(&value.non_goals)?;
        if value.max_continuations == 0 || value.continuations > value.max_continuations {
            return Err(GoalError::InvalidField);
        }
        Ok(Self {
            request: value.request,
            success_criteria: value.success_criteria,
            constraints: value.constraints,
            non_goals: value.non_goals,
            state: value.state,
            max_continuations: value.max_continuations,
            continuations: value.continuations,
            paused_from: value.paused_from,
            blocked_from: value.blocked_from,
        })
    }
}

impl<'de> Deserialize<'de> for Goal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        UncheckedGoal::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

impl Goal {
    pub fn new(
        objective: String,
        success_criteria: Vec<String>,
        constraints: Vec<String>,
        non_goals: Vec<String>,
        max_continuations: NonZeroU8,
    ) -> Result<Self, GoalError> {
        validate_objective(&objective)?;
        validate_items(&success_criteria)?;
        validate_items(&constraints)?;
        validate_items(&non_goals)?;
        Ok(Self {
            request: RequestRecord::new(objective, Vec::new()),
            success_criteria,
            constraints,
            non_goals,
            state: GoalState::Draft,
            max_continuations: max_continuations.get(),
            continuations: 0,
            paused_from: None,
            blocked_from: None,
        })
    }

    #[must_use]
    pub fn objective(&self) -> &str {
        self.request.original_text()
    }

    #[must_use]
    pub fn objective_digest(&self) -> ContentDigest {
        ContentDigest::of(self.objective().as_bytes())
    }

    #[must_use]
    pub fn request_digest(&self) -> ContentDigest {
        self.request.digest()
    }

    #[must_use]
    pub fn amendments(&self) -> &[RequestAmendment] {
        self.request.amendments()
    }

    #[must_use]
    pub fn success_criteria(&self) -> &[String] {
        &self.success_criteria
    }

    #[must_use]
    pub fn constraints(&self) -> &[String] {
        &self.constraints
    }

    #[must_use]
    pub fn non_goals(&self) -> &[String] {
        &self.non_goals
    }

    #[must_use]
    pub const fn state(&self) -> GoalState {
        self.state
    }

    #[must_use]
    pub const fn continuations(&self) -> u8 {
        self.continuations
    }

    #[must_use]
    pub const fn max_continuations(&self) -> u8 {
        self.max_continuations
    }

    pub fn append_amendment(
        &mut self,
        text: String,
        received_at: WorkflowTimestamp,
    ) -> Result<(), GoalError> {
        if self.state.is_terminal() || text.trim().is_empty() || text.len() > MAX_OBJECTIVE_BYTES {
            return Err(GoalError::InvalidTransition);
        }
        self.request
            .append_amendment(text, received_at)
            .map_err(GoalError::Request)
    }

    pub fn apply(&mut self, command: GoalCommand) -> Result<Vec<GoalEvent>, GoalError> {
        match command {
            GoalCommand::StartPlanning if self.state == GoalState::Draft => {
                Ok(self.transition(GoalState::Planning))
            }
            GoalCommand::MarkReady if self.state == GoalState::Planning => {
                Ok(self.transition(GoalState::Ready))
            }
            GoalCommand::Activate if self.state == GoalState::Ready => {
                Ok(self.transition(GoalState::Active))
            }
            GoalCommand::Pause
                if matches!(
                    self.state,
                    GoalState::Planning | GoalState::Ready | GoalState::Active
                ) =>
            {
                self.paused_from = Some(self.state);
                Ok(self.transition(GoalState::Paused))
            }
            GoalCommand::Resume if self.state == GoalState::Paused => {
                let previous = self
                    .paused_from
                    .take()
                    .ok_or(GoalError::InvalidTransition)?;
                Ok(self.transition(previous))
            }
            GoalCommand::Block
                if matches!(
                    self.state,
                    GoalState::Planning | GoalState::Active | GoalState::Completing
                ) =>
            {
                self.blocked_from = Some(self.state);
                Ok(self.transition(GoalState::Blocked))
            }
            GoalCommand::ResumeBlocked if self.state == GoalState::Blocked => {
                let previous = self
                    .blocked_from
                    .take()
                    .ok_or(GoalError::InvalidTransition)?;
                Ok(self.transition(previous))
            }
            GoalCommand::Continue if self.state == GoalState::Active => self.continue_goal(),
            GoalCommand::RequestCompletion if self.state == GoalState::Active => {
                Ok(self.transition(GoalState::Completing))
            }
            GoalCommand::ApproveCompletion if self.state == GoalState::Completing => {
                Ok(self.transition(GoalState::Completed))
            }
            GoalCommand::RejectCompletion if self.state == GoalState::Completing => {
                Ok(self.transition(GoalState::Active))
            }
            GoalCommand::Abort if !self.state.is_terminal() => {
                self.paused_from = None;
                self.blocked_from = None;
                Ok(self.transition(GoalState::Aborted))
            }
            _ => Err(GoalError::InvalidTransition),
        }
    }

    fn continue_goal(&mut self) -> Result<Vec<GoalEvent>, GoalError> {
        self.continuations = self
            .continuations
            .checked_add(1)
            .ok_or(GoalError::InvalidTransition)?;
        let mut events = vec![GoalEvent::ContinuationRecorded {
            current: self.continuations,
            maximum: self.max_continuations,
        }];
        if self.continuations >= self.max_continuations {
            self.blocked_from = Some(self.state);
            events.push(GoalEvent::ContinuationLimitReached {
                maximum: self.max_continuations,
            });
            events.extend(self.transition(GoalState::Blocked));
        }
        Ok(events)
    }

    fn transition(&mut self, to: GoalState) -> Vec<GoalEvent> {
        let from = self.state;
        self.state = to;
        vec![GoalEvent::StateChanged { from, to }]
    }
}

fn validate_objective(value: &str) -> Result<(), GoalError> {
    if value.trim().is_empty() || value.len() > MAX_OBJECTIVE_BYTES {
        Err(GoalError::InvalidObjective)
    } else {
        Ok(())
    }
}

fn validate_items(values: &[String]) -> Result<(), GoalError> {
    if values.len() > MAX_ITEMS
        || values
            .iter()
            .any(|value| value.trim().is_empty() || value.len() > MAX_TEXT_BYTES)
    {
        Err(GoalError::InvalidField)
    } else {
        Ok(())
    }
}
