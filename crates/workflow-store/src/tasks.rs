use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use workflow_core::{Task, TaskCommand, TaskEvent, TaskId, WorkflowId, WorkflowTimestamp};

use crate::{Store, StoreError, StoreMode, validate_idempotency_key};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskApplyResult {
    pub duplicate: bool,
    pub events: Vec<TaskEvent>,
    pub state: Task,
}

#[derive(Deserialize, Serialize)]
struct PersistedResult {
    events: Vec<TaskEvent>,
    state: Task,
}

impl Store {
    pub fn load_workflow_tasks(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Vec<(TaskId, Task)>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT id, state_json FROM tasks WHERE workflow_id = ?1 ORDER BY id")?;
        let rows = statement.query_map([workflow_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (task_id, state) = row?;
            Ok((
                task_id.parse().map_err(|_| StoreError::AggregateConflict)?,
                serde_json::from_str(&state)?,
            ))
        })
        .collect()
    }

    pub fn apply_task_command(
        &mut self,
        workflow_id: WorkflowId,
        task_id: TaskId,
        idempotency_key: &str,
        command: TaskCommand,
        timestamp: WorkflowTimestamp,
    ) -> Result<TaskApplyResult, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_idempotency_key(idempotency_key)?;
        let transaction = self.connection.transaction()?;
        let persisted: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT aggregate_type, aggregate_id, result_json
                 FROM command_deduplication WHERE idempotency_key = ?1",
                [idempotency_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((aggregate_type, aggregate_id, json)) = persisted {
            if aggregate_type != "task" || aggregate_id != task_id.to_string() {
                return Err(StoreError::IdempotencyConflict);
            }
            let result: PersistedResult = serde_json::from_str(&json)?;
            return Ok(TaskApplyResult {
                duplicate: true,
                events: result.events,
                state: result.state,
            });
        }

        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT workflow_id, state_json FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if current
            .as_ref()
            .is_some_and(|(owner, _)| owner != &workflow_id.to_string())
        {
            return Err(StoreError::AggregateConflict);
        }
        let mut state =
            current.map_or_else(|| Ok(Task::new()), |(_, json)| serde_json::from_str(&json))?;
        let events = state.apply(command)?;
        let state_json = serde_json::to_string(&state)?;
        let timestamp = timestamp.to_string();
        transaction.execute(
            "INSERT INTO tasks(id, workflow_id, state_json, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
            params![task_id.to_string(), workflow_id.to_string(), state_json, timestamp],
        )?;
        for event in &events {
            transaction.execute(
                "INSERT INTO events(aggregate_type, aggregate_id, event_json, created_at)
                 VALUES ('task', ?1, ?2, ?3)",
                params![
                    task_id.to_string(),
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
             VALUES (?1, 'task', ?2, ?3, ?4)",
            params![
                idempotency_key,
                task_id.to_string(),
                serde_json::to_string(&result)?,
                timestamp
            ],
        )?;
        transaction.commit()?;
        Ok(TaskApplyResult {
            duplicate: false,
            events,
            state,
        })
    }

    pub fn load_task(&self, task_id: TaskId) -> Result<Option<Task>, StoreError> {
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT state_json FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(StoreError::from)
    }
}
