use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use workflow_core::{CandidateId, ContentDigest, EvidenceId, TaskId, WorkflowId, WorkflowRole};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuditModel {
    pub model: String,
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum AuditData {
    Workflow {
        action: String,
    },
    Tool {
        invocation_digest: ContentDigest,
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
pub struct AuditObservation {
    pub actor_id: String,
    pub candidate_id: Option<CandidateId>,
    pub data: AuditData,
    pub evidence_ids: BTreeSet<EvidenceId>,
    pub files: BTreeSet<String>,
    pub metadata: BTreeMap<String, String>,
    pub model: Option<AuditModel>,
    pub project_key: String,
    pub role: Option<WorkflowRole>,
    pub session_id: Option<String>,
    pub task_id: Option<TaskId>,
    pub timestamp_unix_millis: i64,
    pub workflow_id: Option<WorkflowId>,
}
