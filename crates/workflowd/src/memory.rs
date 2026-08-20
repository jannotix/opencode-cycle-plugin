use std::path::Path;

use serde_json::{Value, json};
use workflow_core::ProjectId;
use workflow_ipc::protocol::MemoryOperation;
use workflow_memory::{
    ConfidenceClass, MemorySearch, MemoryStore, MemoryStoreError, RetrievalBudget, compact,
};

#[derive(Debug)]
pub enum MemoryCommandError {
    InvalidConfidence,
    InvalidProject,
    Store(MemoryStoreError),
}

impl std::fmt::Display for MemoryCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfidence => formatter.write_str("memory confidence filter is invalid"),
            Self::InvalidProject => formatter.write_str("project key cannot be empty"),
            Self::Store(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for MemoryCommandError {}

impl From<MemoryStoreError> for MemoryCommandError {
    fn from(value: MemoryStoreError) -> Self {
        Self::Store(value)
    }
}

pub fn execute(
    database: &Path,
    project_key: &str,
    operation: MemoryOperation,
) -> Result<Value, MemoryCommandError> {
    if project_key.trim().is_empty() {
        return Err(MemoryCommandError::InvalidProject);
    }
    let project_id = ProjectId::from_stable_key(project_key);
    let mut store = MemoryStore::open(database)?;
    match operation {
        MemoryOperation::Search {
            confidence,
            limit,
            scope,
            text,
        } => {
            let confidence = confidence.map(parse_confidence).transpose()?;
            let item_limit = limit.clamp(1, 100);
            let entries = store.search(&MemorySearch {
                confidence,
                from: None,
                include_inactive: false,
                limit: item_limit.saturating_add(1),
                project_id,
                scope,
                text,
                to: None,
            })?;
            Ok(json!({
                "entries": compact(
                    &entries,
                    RetrievalBudget {
                        max_bytes: 32 * 1024,
                        max_items: item_limit,
                    },
                ),
                "truncated": entries.len() > item_limit,
            }))
        }
        MemoryOperation::Explain { memory_id } => Ok(json!({
            "entry": store.get(project_id, memory_id)?,
        })),
        MemoryOperation::Remove { memory_id } => {
            store.revoke(project_id, memory_id)?;
            Ok(json!({ "memory_id": memory_id, "state": "revoked" }))
        }
    }
}

fn parse_confidence(value: String) -> Result<ConfidenceClass, MemoryCommandError> {
    match value.as_str() {
        "inferred" => Ok(ConfidenceClass::Inferred),
        "user_asserted" => Ok(ConfidenceClass::UserAsserted),
        "verified" => Ok(ConfidenceClass::Verified),
        _ => Err(MemoryCommandError::InvalidConfidence),
    }
}
