use serde::{Deserialize, Serialize};

use crate::{ContentDigest, EvidenceId, WorkflowTimestamp};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Command,
    Test,
    Build,
    Lint,
    Database,
    Browser,
    Security,
    Inspection,
    Package,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct EvidenceRecord {
    pub id: EvidenceId,
    pub candidate_digest: ContentDigest,
    pub kind: EvidenceKind,
    pub invocation: String,
    pub tool: String,
    pub tool_version: String,
    pub started_at: WorkflowTimestamp,
    pub finished_at: WorkflowTimestamp,
    pub exit_code: Option<i32>,
    pub output_digest: ContentDigest,
    pub status: EvidenceStatus,
    pub skip_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceValidationError {
    InvalidTimeRange,
    MissingInvocation,
    InvalidExitCode,
    MissingSkipReason,
    UnexpectedSkipReason,
}

impl std::fmt::Display for EvidenceValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTimeRange => "evidence timestamps are invalid",
            Self::MissingInvocation => "evidence invocation or tool is missing",
            Self::InvalidExitCode => "evidence exit status is inconsistent",
            Self::MissingSkipReason => "skipped evidence requires a reason",
            Self::UnexpectedSkipReason => "non-skipped evidence cannot include a skip reason",
        })
    }
}

impl std::error::Error for EvidenceValidationError {}

impl EvidenceRecord {
    pub fn validate(&self) -> Result<(), EvidenceValidationError> {
        if self.finished_at < self.started_at {
            return Err(EvidenceValidationError::InvalidTimeRange);
        }
        if self.invocation.trim().is_empty() || self.tool.trim().is_empty() {
            return Err(EvidenceValidationError::MissingInvocation);
        }
        match self.status {
            EvidenceStatus::Passed
                if self.kind != EvidenceKind::Inspection && self.exit_code != Some(0) =>
            {
                Err(EvidenceValidationError::InvalidExitCode)
            }
            EvidenceStatus::Failed if self.exit_code.is_none_or(|code| code == 0) => {
                Err(EvidenceValidationError::InvalidExitCode)
            }
            EvidenceStatus::Skipped
                if self
                    .skip_reason
                    .as_deref()
                    .is_none_or(|reason| reason.trim().is_empty()) =>
            {
                Err(EvidenceValidationError::MissingSkipReason)
            }
            EvidenceStatus::Passed | EvidenceStatus::Failed if self.skip_reason.is_some() => {
                Err(EvidenceValidationError::UnexpectedSkipReason)
            }
            _ => Ok(()),
        }
    }
}
