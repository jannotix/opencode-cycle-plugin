use std::collections::BTreeSet;

use rusqlite::{OptionalExtension, params};
use workflow_core::{
    CandidateId, ReviewVerdict, WorkflowId, WorkflowRole, WorkflowState, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn save_review_once(
        &mut self,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
        verdict: &ReviewVerdict,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let role = review_role(verdict.role).ok_or(StoreError::AggregateConflict)?;
        let verdict_json = serde_json::to_string(verdict)?;
        let current: Option<String> = self
            .connection
            .query_row(
                "SELECT verdict_json FROM workflow_reviews WHERE candidate_id = ?1 AND role = ?2",
                params![candidate_id.to_string(), role],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(current) = current {
            return if current == verdict_json {
                Ok(true)
            } else {
                Err(StoreError::AggregateConflict)
            };
        }
        let state = self
            .load_workflow(workflow_id)?
            .ok_or(StoreError::AggregateConflict)?;
        if state.state() != WorkflowState::IndependentReviews
            || state.current_candidate() != Some(candidate_id)
        {
            return Err(StoreError::AggregateConflict);
        }
        let candidate = self
            .load_candidate(candidate_id)?
            .ok_or(StoreError::AggregateConflict)?;
        if candidate.workflow_id != workflow_id
            || verdict.candidate_digest != candidate.manifest.digest()
        {
            return Err(StoreError::AggregateConflict);
        }
        let architecture = self
            .load_architecture(workflow_id)?
            .ok_or(StoreError::AggregateConflict)?;
        let required: BTreeSet<_> = architecture
            .requirements
            .iter()
            .map(|requirement| requirement.id.clone())
            .collect();
        let evidence: BTreeSet<_> = self
            .load_candidate_evidence(candidate_id)?
            .into_iter()
            .map(|(record, _, _)| record.id)
            .collect();
        verdict
            .validate(&required, &evidence)
            .map_err(StoreError::Review)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO workflow_reviews(candidate_id, role, verdict_json, finalized_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                candidate_id.to_string(),
                role,
                verdict_json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_reviews(
        &self,
        candidate_id: CandidateId,
    ) -> Result<Vec<ReviewVerdict>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT verdict_json FROM workflow_reviews WHERE candidate_id = ?1 ORDER BY role",
        )?;
        let rows =
            statement.query_map([candidate_id.to_string()], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}

const fn review_role(role: WorkflowRole) -> Option<&'static str> {
    match role {
        WorkflowRole::FunctionalReviewer => Some("functional_reviewer"),
        WorkflowRole::SecurityArchitectureReviewer => Some("security_architecture_reviewer"),
        WorkflowRole::Architect | WorkflowRole::Executor | WorkflowRole::Arbiter => None,
    }
}
