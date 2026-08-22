use rusqlite::{OptionalExtension, params};
use workflow_core::{
    ArchitecturePlan, RequestRecord, Workflow, WorkflowId, WorkflowState, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn save_architecture_once(
        &mut self,
        workflow_id: WorkflowId,
        plan: &ArchitecturePlan,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let transaction = self.connection.transaction()?;
        let request_json: String = transaction
            .query_row(
                "SELECT request_json FROM workflow_requests WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StoreError::AggregateConflict)?;
        let request: RequestRecord = serde_json::from_str(&request_json)?;
        if request.digest() != plan.request_digest {
            return Err(StoreError::RequestDigestMismatch);
        }
        let plan_json = serde_json::to_string(plan)?;
        let timestamp = timestamp.to_string();
        let tasks = plan
            .tasks
            .iter()
            .map(|task| (task.id, task.dependencies.is_empty()))
            .collect::<Vec<_>>();
        let current: Option<String> = transaction
            .query_row(
                "SELECT plan_json FROM workflow_architecture WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(current) = current {
            if current == plan_json {
                crate::tasks::reconcile_architecture_tasks(
                    &transaction,
                    workflow_id,
                    &tasks,
                    &[],
                    &timestamp,
                )?;
                transaction.commit()?;
                return Ok(true);
            }
            let previous: ArchitecturePlan = serde_json::from_str(&current)?;
            let previous_ids = previous
                .tasks
                .iter()
                .map(|task| task.id)
                .collect::<std::collections::BTreeSet<_>>();
            if plan
                .tasks
                .iter()
                .any(|task| previous_ids.contains(&task.id))
            {
                return Err(StoreError::AggregateConflict);
            }
            let state_json: String = transaction.query_row(
                "SELECT state_json FROM workflows WHERE id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )?;
            let state: Workflow = serde_json::from_str(&state_json)?;
            if state.state() != WorkflowState::Architecture || state.repair_cycles() == 0 {
                return Err(StoreError::AggregateConflict);
            }
            let revision: u32 = transaction.query_row(
                "SELECT COALESCE(MAX(revision), 0) + 1
                 FROM workflow_architecture_versions WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )?;
            transaction.execute(
                "UPDATE workflow_architecture
                 SET request_digest = ?2, plan_digest = ?3, plan_json = ?4, created_at = ?5
                 WHERE workflow_id = ?1",
                params![
                    workflow_id.to_string(),
                    plan.request_digest.to_string(),
                    plan.digest().to_string(),
                    plan_json,
                    timestamp
                ],
            )?;
            transaction.execute(
                "INSERT INTO workflow_architecture_versions
                 (workflow_id, revision, request_digest, plan_digest, plan_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    workflow_id.to_string(),
                    revision,
                    plan.request_digest.to_string(),
                    plan.digest().to_string(),
                    plan_json,
                    timestamp
                ],
            )?;
            let superseded = previous_ids.into_iter().collect::<Vec<_>>();
            crate::tasks::reconcile_architecture_tasks(
                &transaction,
                workflow_id,
                &tasks,
                &superseded,
                &timestamp,
            )?;
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO workflow_architecture
             (workflow_id, request_digest, plan_digest, plan_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workflow_id.to_string(),
                plan.request_digest.to_string(),
                plan.digest().to_string(),
                plan_json,
                timestamp
            ],
        )?;
        transaction.execute(
            "INSERT INTO workflow_architecture_versions
             (workflow_id, revision, request_digest, plan_digest, plan_json, created_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5)",
            params![
                workflow_id.to_string(),
                plan.request_digest.to_string(),
                plan.digest().to_string(),
                plan_json,
                timestamp
            ],
        )?;
        crate::tasks::reconcile_architecture_tasks(
            &transaction,
            workflow_id,
            &tasks,
            &[],
            &timestamp,
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_architecture(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Option<ArchitecturePlan>, StoreError> {
        let plan: Option<String> = self
            .connection
            .query_row(
                "SELECT plan_json FROM workflow_architecture WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        plan.map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn load_architecture_versions(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Vec<ArchitecturePlan>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT plan_json FROM workflow_architecture_versions
             WHERE workflow_id = ?1 ORDER BY revision",
        )?;
        let rows = statement.query_map([workflow_id.to_string()], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}
