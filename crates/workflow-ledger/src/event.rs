use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use workflow_core::{
    CandidateId, EventId, EvidenceId, ProjectId, TaskId, WorkflowId, WorkflowRole,
    WorkflowTimestamp,
};

use crate::Redactor;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelIdentity {
    pub model: String,
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    pub id: String,
    pub model: Option<ModelIdentity>,
    pub role: Option<WorkflowRole>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum EventData {
    Workflow {
        action: String,
    },
    Tool {
        invocation_digest: String,
        tool: String,
    },
    Permission {
        decision: String,
        permission: String,
    },
    Git {
        externally_attributed: bool,
        revision: String,
    },
    Verification {
        gate: String,
        status: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LedgerEvent {
    pub actor: Actor,
    pub candidate_id: Option<CandidateId>,
    pub data: EventData,
    pub event_id: EventId,
    pub evidence_ids: BTreeSet<EvidenceId>,
    pub files: BTreeSet<String>,
    pub metadata: BTreeMap<String, String>,
    pub project_id: ProjectId,
    pub task_id: Option<TaskId>,
    pub timestamp: WorkflowTimestamp,
    pub workflow_id: Option<WorkflowId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventError {
    EmptyActor,
    EmptyData,
    UnsafePath,
}

impl std::fmt::Display for EventError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::EmptyActor => "ledger actor identifier cannot be empty",
            Self::EmptyData => "ledger event fields cannot be empty",
            Self::UnsafePath => "ledger file path must be project-relative and traversal-free",
        })
    }
}

impl std::error::Error for EventError {}

impl LedgerEvent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        actor: Actor,
        candidate_id: Option<CandidateId>,
        data: EventData,
        evidence_ids: impl IntoIterator<Item = EvidenceId>,
        files: impl IntoIterator<Item = String>,
        metadata: BTreeMap<String, String>,
        project_id: ProjectId,
        task_id: Option<TaskId>,
        timestamp: WorkflowTimestamp,
        workflow_id: Option<WorkflowId>,
        redactor: &Redactor,
    ) -> Result<Self, EventError> {
        if actor.id.trim().is_empty() {
            return Err(EventError::EmptyActor);
        }
        validate_data(&data)?;
        let files: BTreeSet<_> = files.into_iter().map(|path| redactor.value(path)).collect();
        if files.iter().any(|path| !safe_relative_path(path)) {
            return Err(EventError::UnsafePath);
        }
        Ok(Self {
            actor: redactor.actor(actor),
            candidate_id,
            data: redactor.data(data),
            event_id: EventId::new(),
            evidence_ids: evidence_ids.into_iter().collect(),
            files,
            metadata: redactor.metadata(metadata),
            project_id,
            task_id,
            timestamp,
            workflow_id,
        })
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

fn validate_data(data: &EventData) -> Result<(), EventError> {
    let fields: &[&str] = match data {
        EventData::Workflow { action } => &[action],
        EventData::Tool {
            invocation_digest,
            tool,
        } => &[invocation_digest, tool],
        EventData::Permission {
            decision,
            permission,
        } => &[decision, permission],
        EventData::Git { revision, .. } => &[revision],
        EventData::Verification { gate, status } => &[gate, status],
    };
    if fields.iter().any(|value| value.trim().is_empty()) {
        Err(EventError::EmptyData)
    } else {
        Ok(())
    }
}

fn safe_relative_path(value: &str) -> bool {
    let path = std::path::Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}
