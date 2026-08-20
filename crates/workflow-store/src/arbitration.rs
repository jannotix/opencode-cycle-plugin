use rusqlite::{OptionalExtension, params};
use workflow_core::{
    ArbiterVerdict, ArbitrationReceipt, CandidateId, WorkflowId, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn save_arbitration_once(
        &mut self,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
        verdict: &ArbiterVerdict,
        receipt: &ArbitrationReceipt,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        if receipt.workflow_id != workflow_id
            || receipt.candidate_id != candidate_id
            || receipt.candidate_digest != verdict.candidate_digest
            || receipt.arbiter_verdict_digest != verdict.digest()
        {
            return Err(StoreError::AggregateConflict);
        }
        let verdict_json = serde_json::to_string(verdict)?;
        let receipt_json = serde_json::to_string(receipt)?;
        let transaction = self.connection.transaction()?;
        let current: Option<(String, String, String, String)> = transaction
            .query_row(
                "SELECT workflow_id, verdict_json, receipt_digest, receipt_json
                 FROM workflow_arbitration WHERE candidate_id = ?1",
                [candidate_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some(current) = current {
            let expected = (
                workflow_id.to_string(),
                verdict_json,
                receipt.digest().to_string(),
                receipt_json,
            );
            if current != expected {
                return Err(StoreError::AggregateConflict);
            }
            return Ok(true);
        }
        transaction.execute(
            "INSERT INTO workflow_arbitration
             (candidate_id, workflow_id, verdict_json, receipt_digest, receipt_json, finalized_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                candidate_id.to_string(),
                workflow_id.to_string(),
                verdict_json,
                receipt.digest().to_string(),
                receipt_json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_arbitration(
        &self,
        candidate_id: CandidateId,
    ) -> Result<Option<(WorkflowId, ArbiterVerdict, ArbitrationReceipt)>, StoreError> {
        let value: Option<(String, String, String)> = self
            .connection
            .query_row(
                "SELECT workflow_id, verdict_json, receipt_json
                 FROM workflow_arbitration WHERE candidate_id = ?1",
                [candidate_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        value
            .map(|(workflow_id, verdict, receipt)| {
                Ok((
                    workflow_id
                        .parse()
                        .map_err(|_| StoreError::AggregateConflict)?,
                    serde_json::from_str(&verdict)?,
                    serde_json::from_str(&receipt)?,
                ))
            })
            .transpose()
    }
}
