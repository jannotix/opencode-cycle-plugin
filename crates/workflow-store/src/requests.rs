use rusqlite::{OptionalExtension, params};
use workflow_core::{ProjectId, RequestRecord, WorkflowId, WorkflowTimestamp};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn latest_workflow_for_project(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<WorkflowId>, StoreError> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT workflow_id FROM workflow_requests
                 WHERE project_id = ?1 ORDER BY created_at DESC, workflow_id DESC LIMIT 1",
                [project_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|workflow_id| {
                workflow_id
                    .parse()
                    .map_err(|_| StoreError::AggregateConflict)
            })
            .transpose()
    }

    pub fn save_request_once(
        &mut self,
        workflow_id: WorkflowId,
        project_id: ProjectId,
        request: &RequestRecord,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let request_json = serde_json::to_string(request)?;
        let transaction = self.connection.transaction()?;
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT project_id, request_json FROM workflow_requests WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((current_project, current_request)) = current {
            if current_project != project_id.to_string() || current_request != request_json {
                return Err(StoreError::AggregateConflict);
            }
            return Ok(true);
        }
        transaction.execute(
            "INSERT INTO workflow_requests(workflow_id, project_id, request_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                workflow_id.to_string(),
                project_id.to_string(),
                request_json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_request(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Option<(ProjectId, RequestRecord)>, StoreError> {
        let value: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT project_id, request_json FROM workflow_requests WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        value
            .map(|(project_id, request)| {
                Ok((
                    project_id
                        .parse()
                        .map_err(|_| StoreError::AggregateConflict)?,
                    serde_json::from_str(&request)?,
                ))
            })
            .transpose()
    }
}
