use std::path::Path;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use workflow_core::{ContentDigest, ProjectId, WorkflowId, WorkflowTimestamp};

use crate::{Store, StoreError, StoreMode};

const WORKTREE_BINDING_KIND: &str = "prepared_worktree";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorktreeBinding {
    pub base_revision: String,
    pub path: String,
    pub project_id: ProjectId,
    pub workflow_id: WorkflowId,
}

impl Store {
    pub fn save_worktree_binding_once(
        &mut self,
        binding: &WorktreeBinding,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_binding(binding)?;
        let json = serde_json::to_string(binding)?;
        let digest = ContentDigest::of(json.as_bytes()).to_string();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner: Option<String> = transaction
            .query_row(
                "SELECT project_id FROM workflow_requests WHERE workflow_id = ?1",
                [binding.workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let expected_owner = binding.project_id.to_string();
        if owner.as_deref() != Some(expected_owner.as_str()) {
            return Err(StoreError::AggregateConflict);
        }
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT constraint_digest, constraint_json FROM workflow_constraints
                 WHERE workflow_id = ?1 AND kind = ?2",
                params![binding.workflow_id.to_string(), WORKTREE_BINDING_KIND],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((current_digest, current_json)) = current {
            let current_binding: WorktreeBinding = serde_json::from_str(&current_json)?;
            validate_binding(&current_binding)?;
            if current_binding != *binding
                || current_digest != ContentDigest::of(current_json.as_bytes()).to_string()
            {
                return Err(StoreError::AggregateConflict);
            }
            return Ok(true);
        }
        transaction.execute(
            "INSERT INTO workflow_constraints
             (workflow_id, kind, constraint_digest, constraint_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                binding.workflow_id.to_string(),
                WORKTREE_BINDING_KIND,
                digest,
                json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_worktree_binding(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Option<WorktreeBinding>, StoreError> {
        let current: Option<(String, String, String)> = self
            .connection
            .query_row(
                "SELECT constraints.constraint_digest, constraints.constraint_json,
                        requests.project_id
                 FROM workflow_constraints AS constraints
                 INNER JOIN workflow_requests AS requests
                    ON requests.workflow_id = constraints.workflow_id
                 WHERE constraints.workflow_id = ?1 AND constraints.kind = ?2",
                params![workflow_id.to_string(), WORKTREE_BINDING_KIND],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        current
            .map(|(digest, json, owner)| {
                let binding: WorktreeBinding = serde_json::from_str(&json)?;
                validate_binding(&binding)?;
                if binding.workflow_id != workflow_id
                    || binding.project_id.to_string() != owner
                    || digest != ContentDigest::of(json.as_bytes()).to_string()
                {
                    return Err(StoreError::AggregateConflict);
                }
                Ok(binding)
            })
            .transpose()
    }
}

fn validate_binding(binding: &WorktreeBinding) -> Result<(), StoreError> {
    if binding.path.is_empty()
        || binding.path.len() > 32_768
        || binding.path.contains('\0')
        || !Path::new(&binding.path).is_absolute()
        || !matches!(binding.base_revision.len(), 40 | 64)
        || binding
            .base_revision
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(StoreError::AggregateConflict);
    }
    Ok(())
}
