use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use workflow_core::{
    ContentDigest, ReceiptId, Task, TaskCommand, TaskEvent, TaskId, WorkflowId, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode, validate_idempotency_key};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskApplyResult {
    pub duplicate: bool,
    pub events: Vec<TaskEvent>,
    pub state: Task,
}

pub struct VerifiedTaskClosure<'a> {
    pub workflow_id: WorkflowId,
    pub task_id: TaskId,
    pub receipt_id: ReceiptId,
    pub payload_digest: ContentDigest,
    pub repair_cycle: u8,
    pub ready_dependents: &'a [TaskId],
    pub timestamp: WorkflowTimestamp,
}

#[derive(Deserialize, Serialize)]
struct PersistedResult {
    events: Vec<TaskEvent>,
    state: Task,
}

#[derive(Deserialize, Serialize)]
struct PersistedClosureResult {
    events: Vec<TaskEvent>,
    payload_digest: ContentDigest,
    repair_cycle: u8,
    state: Task,
    workflow_id: WorkflowId,
}

impl Store {
    pub fn seed_architecture_tasks(
        &mut self,
        workflow_id: WorkflowId,
        tasks: &[(TaskId, bool)],
        superseded: &[TaskId],
        timestamp: WorkflowTimestamp,
    ) -> Result<(), StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let transaction = self.connection.transaction()?;
        let timestamp = timestamp.to_string();
        reconcile_architecture_tasks(&transaction, workflow_id, tasks, superseded, &timestamp)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn complete_verified_task_closure(
        &mut self,
        closure: VerifiedTaskClosure<'_>,
    ) -> Result<TaskApplyResult, StoreError> {
        let VerifiedTaskClosure {
            workflow_id,
            task_id,
            receipt_id,
            payload_digest,
            repair_cycle,
            ready_dependents,
            timestamp,
        } = closure;
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let idempotency_key = format!("task-closure:{receipt_id}");
        validate_idempotency_key(&idempotency_key)?;
        let transaction = self.connection.transaction()?;
        let persisted: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT aggregate_type, aggregate_id, result_json
                 FROM command_deduplication WHERE idempotency_key = ?1",
                [&idempotency_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((aggregate_type, aggregate_id, json)) = persisted {
            if aggregate_type != "task_closure" || aggregate_id != task_id.to_string() {
                return Err(StoreError::IdempotencyConflict);
            }
            let result: PersistedClosureResult = serde_json::from_str(&json)?;
            if result.workflow_id != workflow_id || result.payload_digest != payload_digest {
                return Err(StoreError::IdempotencyConflict);
            }
            return Ok(TaskApplyResult {
                duplicate: true,
                events: result.events,
                state: result.state,
            });
        }
        let (semantic_duplicate, previous_repair_cycle) = {
            let mut statement = transaction.prepare(
                "SELECT result_json FROM command_deduplication
                 WHERE aggregate_type = 'task_closure' AND aggregate_id = ?1",
            )?;
            let rows = statement.query_map([task_id.to_string()], |row| row.get::<_, String>(0))?;
            let mut matched = None;
            let mut previous_cycle = None;
            for row in rows {
                let result: PersistedClosureResult = serde_json::from_str(&row?)?;
                if result.workflow_id == workflow_id {
                    previous_cycle =
                        Some(previous_cycle.map_or(result.repair_cycle, |cycle: u8| {
                            cycle.max(result.repair_cycle)
                        }));
                }
                if result.workflow_id == workflow_id && result.payload_digest == payload_digest {
                    matched = Some(result);
                    break;
                }
            }
            (matched, previous_cycle)
        };
        if let Some(result) = semantic_duplicate {
            transaction.execute(
                "INSERT INTO command_deduplication
                 (idempotency_key, aggregate_type, aggregate_id, result_json, created_at)
                 VALUES (?1, 'task_closure', ?2, ?3, ?4)",
                params![
                    idempotency_key,
                    task_id.to_string(),
                    serde_json::to_string(&result)?,
                    timestamp.to_string()
                ],
            )?;
            transaction.commit()?;
            return Ok(TaskApplyResult {
                duplicate: true,
                events: result.events,
                state: result.state,
            });
        }

        let (owner, state_json): (String, String) = transaction
            .query_row(
                "SELECT workflow_id, state_json FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(StoreError::AggregateConflict)?;
        if owner != workflow_id.to_string() {
            return Err(StoreError::AggregateConflict);
        }
        let mut state: Task = serde_json::from_str(&state_json)?;
        let mut events = Vec::new();
        if state.state() == workflow_core::TaskState::Completed {
            if previous_repair_cycle.is_none_or(|cycle| repair_cycle <= cycle) {
                return Err(StoreError::IdempotencyConflict);
            }
            events.extend(state.apply(TaskCommand::RepairRequested)?);
        }
        for command in [
            TaskCommand::Lease,
            TaskCommand::Start,
            TaskCommand::SubmitCandidate,
            TaskCommand::VerificationPassed {
                mandatory_gates_passed: true,
                reviewer_approved: true,
            },
        ] {
            events.extend(state.apply(command)?);
        }
        let timestamp = timestamp.to_string();
        persist_task_state_and_events(
            &transaction,
            workflow_id,
            task_id,
            &state,
            &events,
            &timestamp,
        )?;

        for dependent_id in ready_dependents {
            let (owner, dependent_json): (String, String) = transaction
                .query_row(
                    "SELECT workflow_id, state_json FROM tasks WHERE id = ?1",
                    [dependent_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or(StoreError::AggregateConflict)?;
            if owner != workflow_id.to_string() {
                return Err(StoreError::AggregateConflict);
            }
            let mut dependent: Task = serde_json::from_str(&dependent_json)?;
            let dependent_events = dependent.apply(TaskCommand::DependenciesSatisfied)?;
            persist_task_state_and_events(
                &transaction,
                workflow_id,
                *dependent_id,
                &dependent,
                &dependent_events,
                &timestamp,
            )?;
        }

        let result = PersistedClosureResult {
            events: events.clone(),
            payload_digest,
            repair_cycle,
            state: state.clone(),
            workflow_id,
        };
        transaction.execute(
            "INSERT INTO command_deduplication
             (idempotency_key, aggregate_type, aggregate_id, result_json, created_at)
             VALUES (?1, 'task_closure', ?2, ?3, ?4)",
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

    pub fn load_workflow_tasks(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Vec<(TaskId, Task)>, StoreError> {
        let authoritative = self.load_architecture(workflow_id)?.map(|plan| {
            plan.tasks
                .into_iter()
                .map(|task| task.id)
                .collect::<std::collections::BTreeSet<_>>()
        });
        let mut statement = self
            .connection
            .prepare("SELECT id, state_json FROM tasks WHERE workflow_id = ?1 ORDER BY id")?;
        let rows = statement.query_map([workflow_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let tasks = rows
            .map(|row| {
                let (task_id, state) = row?;
                Ok((
                    task_id.parse().map_err(|_| StoreError::AggregateConflict)?,
                    serde_json::from_str(&state)?,
                ))
            })
            .collect::<Result<Vec<_>, StoreError>>()?;
        Ok(match authoritative {
            Some(ids) => tasks
                .into_iter()
                .filter(|(task_id, _)| ids.contains(task_id))
                .collect(),
            None => tasks,
        })
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

pub(crate) fn reconcile_architecture_tasks(
    transaction: &rusqlite::Transaction<'_>,
    workflow_id: WorkflowId,
    tasks: &[(TaskId, bool)],
    superseded: &[TaskId],
    timestamp: &str,
) -> Result<(), StoreError> {
    let authoritative: std::collections::BTreeSet<_> =
        tasks.iter().map(|(task_id, _)| *task_id).collect();
    let mut stale = superseded
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    {
        let mut statement = transaction.prepare("SELECT id FROM tasks WHERE workflow_id = ?1")?;
        let rows = statement.query_map([workflow_id.to_string()], |row| row.get::<_, String>(0))?;
        for row in rows {
            let task_id: TaskId = row?.parse().map_err(|_| StoreError::AggregateConflict)?;
            if !authoritative.contains(&task_id) {
                stale.insert(task_id);
            }
        }
    }
    for task_id in &stale {
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT workflow_id, state_json FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((owner, state_json)) = current else {
            continue;
        };
        if owner != workflow_id.to_string() {
            return Err(StoreError::AggregateConflict);
        }
        let mut state: Task = serde_json::from_str(&state_json)?;
        if state.state().is_terminal() {
            continue;
        }
        let events = state.apply(TaskCommand::Cancel)?;
        persist_task_state_and_events(
            transaction,
            workflow_id,
            *task_id,
            &state,
            &events,
            timestamp,
        )?;
    }
    for (task_id, root) in tasks {
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT workflow_id, state_json FROM tasks WHERE id = ?1",
                [task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((owner, _)) = current {
            if owner != workflow_id.to_string() {
                return Err(StoreError::AggregateConflict);
            }
            continue;
        }
        let mut state = Task::new();
        let events = if *root {
            state.apply(TaskCommand::DependenciesSatisfied)?
        } else {
            Vec::new()
        };
        persist_task_state_and_events(
            transaction,
            workflow_id,
            *task_id,
            &state,
            &events,
            timestamp,
        )?;
    }
    Ok(())
}

fn persist_task_state_and_events(
    transaction: &rusqlite::Transaction<'_>,
    workflow_id: WorkflowId,
    task_id: TaskId,
    state: &Task,
    events: &[TaskEvent],
    timestamp: &str,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO tasks(id, workflow_id, state_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
        params![
            task_id.to_string(),
            workflow_id.to_string(),
            serde_json::to_string(state)?,
            timestamp
        ],
    )?;
    for event in events {
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
    Ok(())
}
