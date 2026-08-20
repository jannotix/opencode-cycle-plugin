use serde::{Deserialize, Serialize};

use crate::{LeaseId, SessionId, TaskId};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionSafety {
    Idempotent,
    NonIdempotent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseReconciliation {
    Active,
    Replayable,
    ManualReviewRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Lease {
    id: LeaseId,
    task_id: TaskId,
    owner: SessionId,
    acquired_at_unix_millis: i64,
    expires_at_unix_millis: i64,
    safety: ActionSafety,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseError {
    Expired,
    InvalidDuration,
    TimeOverflow,
}

impl std::fmt::Display for LeaseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Expired => "execution lease has expired",
            Self::InvalidDuration => "lease duration must be greater than zero",
            Self::TimeOverflow => "lease expiry exceeds the supported time range",
        })
    }
}

impl std::error::Error for LeaseError {}

impl Lease {
    pub fn acquire(
        task_id: TaskId,
        owner: SessionId,
        now_unix_millis: i64,
        duration_millis: i64,
        safety: ActionSafety,
    ) -> Result<Self, LeaseError> {
        if duration_millis <= 0 {
            return Err(LeaseError::InvalidDuration);
        }
        let expires_at_unix_millis = now_unix_millis
            .checked_add(duration_millis)
            .ok_or(LeaseError::TimeOverflow)?;
        Ok(Self {
            id: LeaseId::new(),
            task_id,
            owner,
            acquired_at_unix_millis: now_unix_millis,
            expires_at_unix_millis,
            safety,
        })
    }

    pub fn heartbeat(
        &mut self,
        now_unix_millis: i64,
        duration_millis: i64,
    ) -> Result<(), LeaseError> {
        if now_unix_millis > self.expires_at_unix_millis {
            return Err(LeaseError::Expired);
        }
        if duration_millis <= 0 {
            return Err(LeaseError::InvalidDuration);
        }
        self.expires_at_unix_millis = now_unix_millis
            .checked_add(duration_millis)
            .ok_or(LeaseError::TimeOverflow)?;
        Ok(())
    }

    #[must_use]
    pub const fn reconcile(self, now_unix_millis: i64) -> LeaseReconciliation {
        if now_unix_millis <= self.expires_at_unix_millis {
            LeaseReconciliation::Active
        } else {
            match self.safety {
                ActionSafety::Idempotent => LeaseReconciliation::Replayable,
                ActionSafety::NonIdempotent => LeaseReconciliation::ManualReviewRequired,
            }
        }
    }

    #[must_use]
    pub const fn id(self) -> LeaseId {
        self.id
    }

    #[must_use]
    pub const fn task_id(self) -> TaskId {
        self.task_id
    }

    #[must_use]
    pub const fn owner(self) -> SessionId {
        self.owner
    }

    #[must_use]
    pub const fn expires_at_unix_millis(self) -> i64 {
        self.expires_at_unix_millis
    }

    #[must_use]
    pub const fn safety(self) -> ActionSafety {
        self.safety
    }
}
