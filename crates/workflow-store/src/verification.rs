use rusqlite::{OptionalExtension, params};
use workflow_core::{
    CandidateId, EvidenceId, EvidenceRecord, VerificationPlanId, WorkflowId, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn save_verification_plan_once(
        &mut self,
        plan_id: VerificationPlanId,
        workflow_id: WorkflowId,
        plan: &serde_json::Value,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let plan_json = serde_json::to_string(plan)?;
        let transaction = self.connection.transaction()?;
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT workflow_id, plan_json FROM workflow_verification_plans WHERE plan_id = ?1",
                [plan_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((owner, current)) = current {
            if owner != workflow_id.to_string() || current != plan_json {
                return Err(StoreError::AggregateConflict);
            }
            return Ok(true);
        }
        transaction.execute(
            "INSERT INTO workflow_verification_plans(plan_id, workflow_id, plan_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                plan_id.to_string(),
                workflow_id.to_string(),
                plan_json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_verification_plan(
        &self,
        plan_id: VerificationPlanId,
    ) -> Result<Option<(WorkflowId, serde_json::Value)>, StoreError> {
        let value: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT workflow_id, plan_json FROM workflow_verification_plans WHERE plan_id = ?1",
                [plan_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        value
            .map(|(workflow_id, plan)| {
                Ok((
                    workflow_id
                        .parse()
                        .map_err(|_| StoreError::AggregateConflict)?,
                    serde_json::from_str(&plan)?,
                ))
            })
            .transpose()
    }

    pub fn load_latest_verification_plan_for_workflow(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Option<(VerificationPlanId, serde_json::Value)>, StoreError> {
        let value: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT plan_id, plan_json FROM workflow_verification_plans
                 WHERE workflow_id = ?1 ORDER BY created_at DESC, plan_id DESC LIMIT 1",
                [workflow_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        value
            .map(|(plan_id, plan)| {
                Ok((
                    plan_id.parse().map_err(|_| StoreError::AggregateConflict)?,
                    serde_json::from_str(&plan)?,
                ))
            })
            .transpose()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_evidence_once(
        &mut self,
        plan_id: VerificationPlanId,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
        record: &EvidenceRecord,
        output_redacted: &str,
        mandatory: bool,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        record.validate().map_err(StoreError::Evidence)?;
        if output_redacted.len() > 2 * 1024 * 1024 {
            return Err(StoreError::AggregateConflict);
        }
        let record_json = serde_json::to_string(record)?;
        let transaction = self.connection.transaction()?;
        let plan_owner: String = transaction.query_row(
            "SELECT workflow_id FROM workflow_verification_plans WHERE plan_id = ?1",
            [plan_id.to_string()],
            |row| row.get(0),
        )?;
        let candidate: (String, String) = transaction.query_row(
            "SELECT workflow_id, manifest_digest FROM workflow_candidates WHERE candidate_id = ?1",
            [candidate_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if plan_owner != workflow_id.to_string()
            || candidate.0 != workflow_id.to_string()
            || candidate.1 != record.candidate_digest.to_string()
        {
            return Err(StoreError::AggregateConflict);
        }
        let current: Option<(String, String, String, bool, String, String)> = transaction
            .query_row(
                "SELECT plan_id, workflow_id, candidate_id, mandatory, record_json, output_redacted
                 FROM workflow_evidence WHERE evidence_id = ?1",
                [record.id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        if let Some(current) = current {
            let identity = (
                plan_id.to_string(),
                workflow_id.to_string(),
                candidate_id.to_string(),
                mandatory,
            );
            if current.0 != identity.0
                || current.1 != identity.1
                || current.2 != identity.2
                || current.3 != identity.3
            {
                return Err(StoreError::AggregateConflict);
            }
            let latest: Option<(i64, String, String)> = transaction
                .query_row(
                    "SELECT attempt, record_json, output_redacted
                     FROM workflow_evidence_attempts WHERE evidence_id = ?1
                     ORDER BY attempt DESC LIMIT 1",
                    [record.id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let (attempt, latest_record, latest_output) =
                latest.unwrap_or((0, current.4.clone(), current.5.clone()));
            if latest_record == record_json && latest_output == output_redacted {
                return Ok(true);
            }
            transaction.execute(
                "INSERT INTO workflow_evidence_attempts
                 (evidence_id, attempt, record_json, output_redacted, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    record.id.to_string(),
                    attempt + 1,
                    record_json,
                    output_redacted,
                    timestamp.to_string(),
                ],
            )?;
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO workflow_evidence
             (evidence_id, plan_id, workflow_id, candidate_id, mandatory, record_json,
              output_redacted, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                record.id.to_string(),
                plan_id.to_string(),
                workflow_id.to_string(),
                candidate_id.to_string(),
                mandatory,
                record_json,
                output_redacted,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_candidate_evidence(
        &self,
        candidate_id: CandidateId,
    ) -> Result<Vec<(EvidenceRecord, String, bool)>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT
                 COALESCE(
                     (SELECT attempt.record_json FROM workflow_evidence_attempts AS attempt
                      WHERE attempt.evidence_id = evidence.evidence_id
                      ORDER BY attempt.attempt DESC LIMIT 1),
                     evidence.record_json
                 ),
                 COALESCE(
                     (SELECT attempt.output_redacted FROM workflow_evidence_attempts AS attempt
                      WHERE attempt.evidence_id = evidence.evidence_id
                      ORDER BY attempt.attempt DESC LIMIT 1),
                     evidence.output_redacted
                 ),
                 evidence.mandatory
             FROM workflow_evidence AS evidence
             WHERE evidence.candidate_id = ?1 ORDER BY evidence.evidence_id",
        )?;
        let rows = statement.query_map([candidate_id.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (record, output, mandatory) = row?;
            Ok((serde_json::from_str(&record)?, output, mandatory))
        })
        .collect()
    }

    pub fn evidence_exists(&self, evidence_id: EvidenceId) -> Result<bool, StoreError> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workflow_evidence WHERE evidence_id = ?1)",
                [evidence_id.to_string()],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }
}
