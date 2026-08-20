use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use workflow_core::{Workflow, WorkflowCommand, WorkflowEvent, WorkflowId, WorkflowTimestamp};

use crate::{Store, StoreError, StoreMode, validate_idempotency_key};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowApplyResult {
    pub duplicate: bool,
    pub events: Vec<WorkflowEvent>,
    pub state: Workflow,
}

#[derive(Deserialize, Serialize)]
struct PersistedResult {
    events: Vec<WorkflowEvent>,
    state: Workflow,
}

impl Store {
    pub fn apply_workflow_command(
        &mut self,
        workflow_id: WorkflowId,
        idempotency_key: &str,
        command: WorkflowCommand,
        timestamp: WorkflowTimestamp,
    ) -> Result<WorkflowApplyResult, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_idempotency_key(idempotency_key)?;
        let transaction = self.connection.transaction()?;
        let reserved: bool = transaction.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM candidate_delivery_reservations WHERE workflow_id = ?1
             )",
            [workflow_id.to_string()],
            |row| row.get(0),
        )?;
        if reserved {
            return Err(StoreError::DeliveryInProgress);
        }
        let persisted: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT aggregate_type, aggregate_id, result_json
                 FROM command_deduplication WHERE idempotency_key = ?1",
                [idempotency_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((aggregate_type, aggregate_id, json)) = persisted {
            if aggregate_type != "workflow" || aggregate_id != workflow_id.to_string() {
                return Err(StoreError::IdempotencyConflict);
            }
            let result: PersistedResult = serde_json::from_str(&json)?;
            return Ok(WorkflowApplyResult {
                duplicate: true,
                events: result.events,
                state: result.state,
            });
        }

        let current: Option<String> = transaction
            .query_row(
                "SELECT state_json FROM workflows WHERE id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        let mut state = current.map_or_else(
            || Ok(Workflow::default()),
            |json| serde_json::from_str(&json),
        )?;
        let events = state.apply(command)?;
        let state_json = serde_json::to_string(&state)?;
        let timestamp = timestamp.to_string();
        transaction.execute(
            "INSERT INTO workflows(id, state_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
            params![workflow_id.to_string(), state_json, timestamp],
        )?;
        for event in &events {
            transaction.execute(
                "INSERT INTO events(aggregate_type, aggregate_id, event_json, created_at)
                 VALUES ('workflow', ?1, ?2, ?3)",
                params![
                    workflow_id.to_string(),
                    serde_json::to_string(event)?,
                    timestamp
                ],
            )?;
        }
        let result = PersistedResult {
            events: events.clone(),
            state: state.clone(),
        };
        transaction.execute(
            "INSERT INTO command_deduplication
             (idempotency_key, aggregate_type, aggregate_id, result_json, created_at)
             VALUES (?1, 'workflow', ?2, ?3, ?4)",
            params![
                idempotency_key,
                workflow_id.to_string(),
                serde_json::to_string(&result)?,
                timestamp
            ],
        )?;
        transaction.commit()?;
        Ok(WorkflowApplyResult {
            duplicate: false,
            events,
            state,
        })
    }

    pub fn deliver_reserved_candidate(
        &mut self,
        workflow_id: WorkflowId,
        candidate_id: workflow_core::CandidateId,
        candidate_digest: workflow_core::ContentDigest,
        journal_digest: workflow_core::ContentDigest,
        idempotency_key: &str,
        timestamp: WorkflowTimestamp,
    ) -> Result<WorkflowApplyResult, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_idempotency_key(idempotency_key)?;
        let transaction = self.connection.transaction()?;
        let reservation: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT workflow_id, candidate_digest, journal_digest
                 FROM candidate_delivery_reservations WHERE candidate_id = ?1",
                [candidate_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if reservation
            != Some((
                workflow_id.to_string(),
                candidate_digest.to_string(),
                journal_digest.to_string(),
            ))
        {
            return Err(StoreError::AggregateConflict);
        }
        let current: String = transaction.query_row(
            "SELECT state_json FROM workflows WHERE id = ?1",
            [workflow_id.to_string()],
            |row| row.get(0),
        )?;
        let mut state: Workflow = serde_json::from_str(&current)?;
        let events = state.apply(WorkflowCommand::Deliver)?;
        let timestamp = timestamp.to_string();
        transaction.execute(
            "UPDATE workflows SET state_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![
                workflow_id.to_string(),
                serde_json::to_string(&state)?,
                timestamp
            ],
        )?;
        for event in &events {
            transaction.execute(
                "INSERT INTO events(aggregate_type, aggregate_id, event_json, created_at)
                 VALUES ('workflow', ?1, ?2, ?3)",
                params![
                    workflow_id.to_string(),
                    serde_json::to_string(event)?,
                    timestamp
                ],
            )?;
        }
        let result = WorkflowApplyResult {
            duplicate: false,
            events,
            state,
        };
        transaction.execute(
            "INSERT INTO command_deduplication
             (idempotency_key, aggregate_type, aggregate_id, result_json, created_at)
             VALUES (?1, 'workflow', ?2, ?3, ?4)",
            params![
                idempotency_key,
                workflow_id.to_string(),
                serde_json::to_string(&PersistedResult {
                    events: result.events.clone(),
                    state: result.state.clone(),
                })?,
                timestamp
            ],
        )?;
        let released = transaction.execute(
            "DELETE FROM candidate_delivery_reservations
             WHERE candidate_id = ?1 AND workflow_id = ?2
               AND candidate_digest = ?3 AND journal_digest = ?4",
            params![
                candidate_id.to_string(),
                workflow_id.to_string(),
                candidate_digest.to_string(),
                journal_digest.to_string()
            ],
        )?;
        if released != 1 {
            return Err(StoreError::AggregateConflict);
        }
        transaction.commit()?;
        Ok(result)
    }

    pub fn load_workflow(&self, workflow_id: WorkflowId) -> Result<Option<Workflow>, StoreError> {
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT state_json FROM workflows WHERE id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(StoreError::from)
    }
}
