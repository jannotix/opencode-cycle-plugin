use std::str::FromStr;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use workflow_core::{
    ContentDigest, Goal, GoalCommand, GoalEvent, GoalId, ProjectId, WorkflowId, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode, validate_idempotency_key};

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalApplyResult {
    pub duplicate: bool,
    pub events: Vec<GoalEvent>,
    pub state: Goal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalPlanRecord {
    pub content: String,
    pub content_digest: ContentDigest,
    pub created_at: WorkflowTimestamp,
    pub revision: u32,
    pub source_session_id: String,
}

#[derive(Deserialize, Serialize)]
struct PersistedGoalResult {
    events: Vec<GoalEvent>,
    state: Goal,
}

impl Store {
    pub fn save_goal_once(
        &mut self,
        goal_id: GoalId,
        project_id: ProjectId,
        goal: &Goal,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let goal_json = serde_json::to_string(goal)?;
        let existing: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT project_id, goal_json FROM goals WHERE goal_id = ?1",
                [goal_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((stored_project, stored_goal)) = existing {
            if stored_project == project_id.to_string() && stored_goal == goal_json {
                return Ok(true);
            }
            return Err(StoreError::AggregateConflict);
        }
        let timestamp = timestamp.to_string();
        self.connection.execute(
            "INSERT INTO goals(goal_id, project_id, goal_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![
                goal_id.to_string(),
                project_id.to_string(),
                goal_json,
                timestamp
            ],
        )?;
        Ok(false)
    }

    pub fn load_goal(&self, goal_id: GoalId) -> Result<Option<(ProjectId, Goal)>, StoreError> {
        let row: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT project_id, goal_json FROM goals WHERE goal_id = ?1",
                [goal_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(project, goal)| {
            Ok((
                ProjectId::from_str(&project).map_err(|_| StoreError::AggregateConflict)?,
                serde_json::from_str(&goal)?,
            ))
        })
        .transpose()
    }

    pub fn list_goals(&self, project_id: ProjectId) -> Result<Vec<(GoalId, Goal)>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT goal_id, goal_json FROM goals
             WHERE project_id = ?1 ORDER BY updated_at DESC, goal_id",
        )?;
        let rows = statement.query_map([project_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (id, goal) = row?;
            Ok((
                GoalId::from_str(&id).map_err(|_| StoreError::AggregateConflict)?,
                serde_json::from_str(&goal)?,
            ))
        })
        .collect()
    }

    pub fn apply_goal_command(
        &mut self,
        goal_id: GoalId,
        idempotency_key: &str,
        command: GoalCommand,
        timestamp: WorkflowTimestamp,
    ) -> Result<GoalApplyResult, StoreError> {
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
            if aggregate_type != "goal" || aggregate_id != goal_id.to_string() {
                return Err(StoreError::IdempotencyConflict);
            }
            let result: PersistedGoalResult = serde_json::from_str(&json)?;
            return Ok(GoalApplyResult {
                duplicate: true,
                events: result.events,
                state: result.state,
            });
        }
        let current: String = transaction.query_row(
            "SELECT goal_json FROM goals WHERE goal_id = ?1",
            [goal_id.to_string()],
            |row| row.get(0),
        )?;
        let mut state: Goal = serde_json::from_str(&current)?;
        let events = state.apply(command)?;
        let timestamp = timestamp.to_string();
        transaction.execute(
            "UPDATE goals SET goal_json = ?2, updated_at = ?3 WHERE goal_id = ?1",
            params![
                goal_id.to_string(),
                serde_json::to_string(&state)?,
                timestamp
            ],
        )?;
        for event in &events {
            transaction.execute(
                "INSERT INTO events(aggregate_type, aggregate_id, event_json, created_at)
                 VALUES ('goal', ?1, ?2, ?3)",
                params![
                    goal_id.to_string(),
                    serde_json::to_string(event)?,
                    timestamp
                ],
            )?;
        }
        let persisted = PersistedGoalResult {
            events: events.clone(),
            state: state.clone(),
        };
        transaction.execute(
            "INSERT INTO command_deduplication
             (idempotency_key, aggregate_type, aggregate_id, result_json, created_at)
             VALUES (?1, 'goal', ?2, ?3, ?4)",
            params![
                idempotency_key,
                goal_id.to_string(),
                serde_json::to_string(&persisted)?,
                timestamp
            ],
        )?;
        transaction.commit()?;
        Ok(GoalApplyResult {
            duplicate: false,
            events,
            state,
        })
    }

    pub fn append_goal_amendment(
        &mut self,
        goal_id: GoalId,
        idempotency_key: &str,
        text: String,
        timestamp: WorkflowTimestamp,
    ) -> Result<Goal, StoreError> {
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
            if aggregate_type != "goal_amendment" || aggregate_id != goal_id.to_string() {
                return Err(StoreError::IdempotencyConflict);
            }
            return serde_json::from_str(&json).map_err(StoreError::from);
        }
        let current: String = transaction.query_row(
            "SELECT goal_json FROM goals WHERE goal_id = ?1",
            [goal_id.to_string()],
            |row| row.get(0),
        )?;
        let mut goal: Goal = serde_json::from_str(&current)?;
        goal.append_amendment(text, timestamp)?;
        let goal_json = serde_json::to_string(&goal)?;
        let amendment = goal
            .amendments()
            .last()
            .ok_or(StoreError::AggregateConflict)?;
        transaction.execute(
            "UPDATE goals SET goal_json = ?2, updated_at = ?3 WHERE goal_id = ?1",
            params![goal_id.to_string(), goal_json, timestamp.to_string()],
        )?;
        transaction.execute(
            "INSERT INTO events(aggregate_type, aggregate_id, event_json, created_at)
             VALUES ('goal', ?1, ?2, ?3)",
            params![
                goal_id.to_string(),
                serde_json::json!({
                    "type": "amendment_appended",
                    "sequence": amendment.sequence,
                    "digest": amendment.digest(),
                })
                .to_string(),
                timestamp.to_string()
            ],
        )?;
        transaction.execute(
            "INSERT INTO command_deduplication
             (idempotency_key, aggregate_type, aggregate_id, result_json, created_at)
             VALUES (?1, 'goal_amendment', ?2, ?3, ?4)",
            params![
                idempotency_key,
                goal_id.to_string(),
                serde_json::to_string(&goal)?,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(goal)
    }

    pub fn focus_goal(
        &mut self,
        project_id: ProjectId,
        session_id: &str,
        goal_id: GoalId,
        timestamp: WorkflowTimestamp,
    ) -> Result<(), StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_session(session_id)?;
        let owner = self
            .load_goal(goal_id)?
            .map(|(owner, _)| owner)
            .ok_or(StoreError::AggregateConflict)?;
        if owner != project_id {
            return Err(StoreError::AggregateConflict);
        }
        self.connection.execute(
            "INSERT INTO goal_focus(project_id, session_id, goal_id, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id, session_id) DO UPDATE SET
               goal_id = excluded.goal_id, updated_at = excluded.updated_at",
            params![
                project_id.to_string(),
                session_id,
                goal_id.to_string(),
                timestamp.to_string()
            ],
        )?;
        Ok(())
    }

    pub fn focused_goal(
        &self,
        project_id: ProjectId,
        session_id: &str,
    ) -> Result<Option<GoalId>, StoreError> {
        validate_session(session_id)?;
        let id: Option<String> = self
            .connection
            .query_row(
                "SELECT goal_id FROM goal_focus WHERE project_id = ?1 AND session_id = ?2",
                params![project_id.to_string(), session_id],
                |row| row.get(0),
            )
            .optional()?;
        id.map(|value| GoalId::from_str(&value).map_err(|_| StoreError::AggregateConflict))
            .transpose()
    }

    pub fn save_goal_plan(
        &mut self,
        goal_id: GoalId,
        source_session_id: &str,
        content: &str,
        timestamp: WorkflowTimestamp,
    ) -> Result<u32, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_session(source_session_id)?;
        if content.trim().is_empty() || content.len() > MAX_DOCUMENT_BYTES {
            return Err(StoreError::AggregateConflict);
        }
        let digest = ContentDigest::of(content.as_bytes());
        if let Some(revision) = self
            .connection
            .query_row(
                "SELECT revision FROM goal_plans WHERE goal_id = ?1 AND content_digest = ?2",
                params![goal_id.to_string(), digest.to_string()],
                |row| row.get::<_, u32>(0),
            )
            .optional()?
        {
            return Ok(revision);
        }
        let revision: u32 = self.connection.query_row(
            "SELECT coalesce(max(revision), 0) + 1 FROM goal_plans WHERE goal_id = ?1",
            [goal_id.to_string()],
            |row| row.get(0),
        )?;
        self.connection.execute(
            "INSERT INTO goal_plans
             (goal_id, revision, source_session_id, content, content_digest, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                goal_id.to_string(),
                revision,
                source_session_id,
                content,
                digest.to_string(),
                timestamp.to_string()
            ],
        )?;
        Ok(revision)
    }

    pub fn load_latest_goal_plan(
        &self,
        goal_id: GoalId,
    ) -> Result<Option<GoalPlanRecord>, StoreError> {
        let row: Option<(u32, String, String, String, String)> = self
            .connection
            .query_row(
                "SELECT revision, source_session_id, content, content_digest, created_at
                 FROM goal_plans WHERE goal_id = ?1 ORDER BY revision DESC LIMIT 1",
                [goal_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(revision, source_session_id, content, digest, created_at)| {
                Ok(GoalPlanRecord {
                    content,
                    content_digest: ContentDigest::from_str(&digest)?,
                    created_at: WorkflowTimestamp::parse(&created_at)
                        .map_err(|_| StoreError::AggregateConflict)?,
                    revision,
                    source_session_id,
                })
            },
        )
        .transpose()
    }

    pub fn link_goal_workflow(
        &mut self,
        goal_id: GoalId,
        workflow_id: WorkflowId,
        milestone: &str,
        timestamp: WorkflowTimestamp,
    ) -> Result<(), StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        if milestone.trim().is_empty() || milestone.len() > 4_096 || milestone.contains('\0') {
            return Err(StoreError::AggregateConflict);
        }
        let existing: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT goal_id, milestone FROM goal_workflows WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((stored_goal, stored_milestone)) = existing {
            return if stored_goal == goal_id.to_string() && stored_milestone == milestone {
                Ok(())
            } else {
                Err(StoreError::AggregateConflict)
            };
        }
        self.connection.execute(
            "INSERT INTO goal_workflows(goal_id, workflow_id, milestone, linked_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                goal_id.to_string(),
                workflow_id.to_string(),
                milestone,
                timestamp.to_string()
            ],
        )?;
        Ok(())
    }

    pub fn goal_workflows(&self, goal_id: GoalId) -> Result<Vec<(WorkflowId, String)>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT workflow_id, milestone FROM goal_workflows
             WHERE goal_id = ?1 ORDER BY linked_at, workflow_id",
        )?;
        let rows = statement.query_map([goal_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (workflow, milestone) = row?;
            Ok((
                WorkflowId::from_str(&workflow).map_err(|_| StoreError::AggregateConflict)?,
                milestone,
            ))
        })
        .collect()
    }
}

fn validate_session(value: &str) -> Result<(), StoreError> {
    if value.trim().is_empty() || value.len() > 512 || value.contains('\0') {
        Err(StoreError::AggregateConflict)
    } else {
        Ok(())
    }
}
