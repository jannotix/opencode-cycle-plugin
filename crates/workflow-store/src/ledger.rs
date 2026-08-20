use std::{collections::BTreeSet, str::FromStr};

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use workflow_core::{ContentDigest, WorkflowId, WorkflowRole};
use workflow_ledger::{
    Checkpoint, CheckpointVerification, EventData, LedgerChain, LedgerEntry, LedgerEvent,
};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn append_ledger_event(&mut self, event: LedgerEvent) -> Result<LedgerEntry, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<(i64, String)> = transaction
            .query_row(
                "SELECT sequence, entry_hash FROM ledger_entries ORDER BY sequence DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (sequence, previous_hash) = match previous {
            Some((sequence, hash)) => (
                u64::try_from(sequence)
                    .map_err(|_| StoreError::IntegerRange)?
                    .checked_add(1)
                    .ok_or(StoreError::IntegerRange)?,
                Some(ContentDigest::from_str(&hash)?),
            ),
            None => (0, None),
        };
        let entry = LedgerEntry::new(sequence, previous_hash, event)?;
        transaction.execute(
            "INSERT INTO ledger_entries(
                sequence, event_id, project_id, workflow_id, task_id, candidate_id,
                actor_id, role, event_json, previous_hash, entry_hash, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                i64::try_from(entry.sequence).map_err(|_| StoreError::IntegerRange)?,
                entry.event.event_id.to_string(),
                entry.event.project_id.to_string(),
                entry.event.workflow_id.map(|id| id.to_string()),
                entry.event.task_id.map(|id| id.to_string()),
                entry.event.candidate_id.map(|id| id.to_string()),
                entry.event.actor.id,
                entry
                    .event
                    .actor
                    .role
                    .map(|role| serde_json::to_string(&role))
                    .transpose()?,
                serde_json::to_string(&entry.event)?,
                entry.previous_hash.map(|hash| hash.to_string()),
                entry.hash.to_string(),
                entry.event.timestamp.to_string(),
            ],
        )?;
        transaction.commit()?;
        Ok(entry)
    }

    pub fn load_ledger(&self) -> Result<LedgerChain, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT sequence, event_json, previous_hash, entry_hash
             FROM ledger_entries ORDER BY sequence",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut entries = Vec::new();
        for row in rows {
            let (sequence, event, previous_hash, hash) = row?;
            entries.push(LedgerEntry {
                event: serde_json::from_str(&event)?,
                hash: ContentDigest::from_str(&hash)?,
                previous_hash: previous_hash
                    .map(|value| ContentDigest::from_str(&value))
                    .transpose()?,
                sequence: u64::try_from(sequence).map_err(|_| StoreError::IntegerRange)?,
            });
        }
        Ok(LedgerChain::from_entries(entries))
    }

    pub fn load_role_session_ids(
        &self,
        workflow_id: WorkflowId,
        role: WorkflowRole,
    ) -> Result<Vec<String>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT event_json FROM ledger_entries
             WHERE workflow_id = ?1 AND role = ?2 ORDER BY sequence",
        )?;
        let serialized_role = serde_json::to_string(&role)?;
        let rows = statement
            .query_map(params![workflow_id.to_string(), serialized_role], |row| {
                row.get::<_, String>(0)
            })?;
        let mut sessions = BTreeSet::new();
        for row in rows {
            let event: LedgerEvent = serde_json::from_str(&row?)?;
            if event.workflow_id != Some(workflow_id) || event.actor.role != Some(role) {
                return Err(StoreError::AggregateConflict);
            }
            if let Some(session_id) = event.actor.session_id {
                if session_id.is_empty() || session_id.len() > 256 {
                    return Err(StoreError::AggregateConflict);
                }
                sessions.insert(session_id);
            }
        }
        Ok(sessions.into_iter().collect())
    }

    pub fn load_worktree_base_revision(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Option<String>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT event_json FROM ledger_entries
             WHERE workflow_id = ?1 ORDER BY sequence DESC",
        )?;
        let rows = statement.query_map([workflow_id.to_string()], |row| row.get::<_, String>(0))?;
        for row in rows {
            let event: LedgerEvent = serde_json::from_str(&row?)?;
            if event.workflow_id != Some(workflow_id) {
                return Err(StoreError::AggregateConflict);
            }
            if event.metadata.get("action").map(String::as_str)
                != Some("execution_worktree_prepared")
            {
                continue;
            }
            let EventData::Git {
                externally_attributed: false,
                revision,
            } = event.data
            else {
                return Err(StoreError::AggregateConflict);
            };
            if matches!(revision.len(), 40 | 64)
                && revision
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Ok(Some(revision));
            }
            return Err(StoreError::AggregateConflict);
        }
        Ok(None)
    }

    pub fn save_checkpoint(&mut self, checkpoint: &Checkpoint) -> Result<(), StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let sequence = i64::try_from(checkpoint.sequence).map_err(|_| StoreError::IntegerRange)?;
        let hash: Option<String> = self
            .connection
            .query_row(
                "SELECT entry_hash FROM ledger_entries WHERE sequence = ?1",
                [sequence],
                |row| row.get(0),
            )
            .optional()?;
        let chain_head = hash
            .map(|hash| ContentDigest::from_str(&hash))
            .transpose()?
            .map(|hash| (checkpoint.sequence, hash));
        if checkpoint.verify_embedded(chain_head) != CheckpointVerification::Valid {
            return Err(StoreError::LedgerCheckpoint);
        }
        self.connection.execute(
            "INSERT INTO ledger_checkpoints(sequence, checkpoint_json, created_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(sequence) DO UPDATE SET
               checkpoint_json = excluded.checkpoint_json,
               created_at = excluded.created_at",
            params![
                sequence,
                serde_json::to_string(checkpoint)?,
                checkpoint.signed_at.to_string(),
            ],
        )?;
        Ok(())
    }

    pub fn load_checkpoints(&self) -> Result<Vec<Checkpoint>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT checkpoint_json FROM ledger_checkpoints ORDER BY sequence")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            row.map_err(StoreError::from)
                .and_then(|json| serde_json::from_str(&json).map_err(StoreError::from))
        })
        .collect()
    }
}
