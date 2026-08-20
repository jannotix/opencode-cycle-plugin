use rusqlite::{OptionalExtension, params};
use workflow_core::{ContentDigest, WorkflowId, WorkflowTimestamp};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn save_constraint_once(
        &mut self,
        workflow_id: WorkflowId,
        kind: &str,
        digest: ContentDigest,
        value: &serde_json::Value,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        if kind.is_empty() || kind.len() > 64 {
            return Err(StoreError::AggregateConflict);
        }
        let json = serde_json::to_string(value)?;
        let transaction = self.connection.transaction()?;
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT constraint_digest, constraint_json FROM workflow_constraints
                 WHERE workflow_id = ?1 AND kind = ?2",
                params![workflow_id.to_string(), kind],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((current_digest, current_json)) = current {
            if current_digest != digest.to_string() || current_json != json {
                return Err(StoreError::AggregateConflict);
            }
            return Ok(true);
        }
        transaction.execute(
            "INSERT INTO workflow_constraints
             (workflow_id, kind, constraint_digest, constraint_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workflow_id.to_string(),
                kind,
                digest.to_string(),
                json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_constraint(
        &self,
        workflow_id: WorkflowId,
        kind: &str,
    ) -> Result<Option<serde_json::Value>, StoreError> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT constraint_json FROM workflow_constraints
                 WHERE workflow_id = ?1 AND kind = ?2",
                params![workflow_id.to_string(), kind],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(StoreError::from)
    }
}
