use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use workflow_core::{CandidateId, EventId, EvidenceId, MemoryId, ProjectId, WorkflowTimestamp};
use workflow_ledger::Redactor;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfidenceClass {
    Inferred,
    UserAsserted,
    Verified,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Approval,
    ArchitectureDecision,
    BugFix,
    Command,
    Constraint,
    Convention,
    FailedApproach,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryState {
    Current,
    Revoked,
    Superseded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub candidate_id: Option<CandidateId>,
    pub evidence_ids: BTreeSet<EvidenceId>,
    pub revision: Option<String>,
    pub source_event_ids: BTreeSet<EventId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryEntry {
    pub actor: String,
    pub confidence: ConfidenceClass,
    pub created_at: WorkflowTimestamp,
    pub detail: String,
    pub id: MemoryId,
    pub kind: MemoryKind,
    pub project_id: ProjectId,
    pub provenance: Provenance,
    pub scope: BTreeSet<String>,
    pub state: MemoryState,
    pub summary: String,
    pub superseded_by: Option<MemoryId>,
    pub title: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryError {
    EmptyActor,
    EmptyContent,
    EmptyProvenance,
    EmptyScope,
    InferredRule,
    InvalidState,
    SensitiveContent,
    UnverifiedClaim,
}

impl std::fmt::Display for MemoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::EmptyActor => "memory actor cannot be empty",
            Self::EmptyContent => "memory title, summary, and detail cannot be empty",
            Self::EmptyProvenance => "memory requires at least one source event",
            Self::EmptyScope => "memory requires at least one applicability scope",
            Self::InferredRule => "inferred memory cannot become a project rule",
            Self::InvalidState => "memory state and supersession link are inconsistent",
            Self::SensitiveContent => "memory contains sensitive content",
            Self::UnverifiedClaim => "verified memory requires verification evidence",
        })
    }
}

impl std::error::Error for MemoryError {}

impl MemoryEntry {
    pub fn validate(&self) -> Result<(), MemoryError> {
        if self.actor.trim().is_empty() {
            return Err(MemoryError::EmptyActor);
        }
        if [&self.title, &self.summary, &self.detail]
            .iter()
            .any(|value| value.trim().is_empty())
        {
            return Err(MemoryError::EmptyContent);
        }
        if self.scope.is_empty() {
            return Err(MemoryError::EmptyScope);
        }
        if self.provenance.source_event_ids.is_empty() {
            return Err(MemoryError::EmptyProvenance);
        }
        if self.confidence == ConfidenceClass::Verified && self.provenance.evidence_ids.is_empty() {
            return Err(MemoryError::UnverifiedClaim);
        }
        if self.confidence == ConfidenceClass::Inferred
            && matches!(self.kind, MemoryKind::Approval | MemoryKind::Constraint)
        {
            return Err(MemoryError::InferredRule);
        }
        if (self.state == MemoryState::Superseded) != self.superseded_by.is_some() {
            return Err(MemoryError::InvalidState);
        }
        let redactor = Redactor::default();
        if [&self.actor, &self.title, &self.summary, &self.detail]
            .iter()
            .copied()
            .chain(self.scope.iter())
            .any(|value| redactor.contains_sensitive(value))
            || self
                .provenance
                .revision
                .as_deref()
                .is_some_and(|value| redactor.contains_sensitive(value))
        {
            return Err(MemoryError::SensitiveContent);
        }
        Ok(())
    }

    #[must_use]
    pub fn can_apply_as_rule(&self) -> bool {
        self.state == MemoryState::Current && self.confidence != ConfidenceClass::Inferred
    }

    pub fn revoke(&mut self) {
        self.state = MemoryState::Revoked;
        self.superseded_by = None;
    }

    pub fn supersede(&mut self, replacement: &MemoryEntry) -> Result<(), MemoryError> {
        replacement.validate()?;
        if self.project_id != replacement.project_id || self.id == replacement.id {
            return Err(MemoryError::InvalidState);
        }
        self.state = MemoryState::Superseded;
        self.superseded_by = Some(replacement.id);
        Ok(())
    }
}
