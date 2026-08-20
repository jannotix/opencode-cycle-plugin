use rusqlite::{OptionalExtension, params};
use workflow_core::{ActionSafety, Lease, LeaseId, LeaseReconciliation, SessionId, TaskId};

use crate::{Store, StoreError, StoreMode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseAcquisition {
    Acquired(Lease),
    Occupied(Lease),
    ManualReviewRequired(Lease),
}

impl Store {
    pub fn acquire_lease(
        &mut self,
        task_id: TaskId,
        owner: SessionId,
        now_unix_millis: i64,
        duration_millis: i64,
        safety: ActionSafety,
    ) -> Result<LeaseAcquisition, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let transaction = self.connection.transaction()?;
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT lease_json, status FROM leases WHERE task_id = ?1",
                [task_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((json, status)) = current {
            let lease: Lease = serde_json::from_str(&json)?;
            if status == "uncertain"
                || lease.reconcile(now_unix_millis) == LeaseReconciliation::ManualReviewRequired
            {
                transaction.execute(
                    "UPDATE leases SET status = 'uncertain', updated_at_unix_millis = ?2
                     WHERE task_id = ?1",
                    params![task_id.to_string(), now_unix_millis],
                )?;
                transaction.commit()?;
                return Ok(LeaseAcquisition::ManualReviewRequired(lease));
            }
            if lease.reconcile(now_unix_millis) == LeaseReconciliation::Active {
                return Ok(LeaseAcquisition::Occupied(lease));
            }
        }

        let lease = Lease::acquire(task_id, owner, now_unix_millis, duration_millis, safety)?;
        transaction.execute(
            "INSERT INTO leases
             (task_id, lease_id, lease_json, status, expires_at_unix_millis, updated_at_unix_millis)
             VALUES (?1, ?2, ?3, 'active', ?4, ?5)
             ON CONFLICT(task_id) DO UPDATE SET
                lease_id = excluded.lease_id,
                lease_json = excluded.lease_json,
                status = 'active',
                expires_at_unix_millis = excluded.expires_at_unix_millis,
                updated_at_unix_millis = excluded.updated_at_unix_millis",
            params![
                task_id.to_string(),
                lease.id().to_string(),
                serde_json::to_string(&lease)?,
                lease.expires_at_unix_millis(),
                now_unix_millis
            ],
        )?;
        transaction.commit()?;
        Ok(LeaseAcquisition::Acquired(lease))
    }

    pub fn heartbeat_lease(
        &mut self,
        lease_id: LeaseId,
        now_unix_millis: i64,
        duration_millis: i64,
    ) -> Result<Lease, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let transaction = self.connection.transaction()?;
        let json: String = transaction
            .query_row(
                "SELECT lease_json FROM leases WHERE lease_id = ?1 AND status = 'active'",
                [lease_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StoreError::LeaseNotFound)?;
        let mut lease: Lease = serde_json::from_str(&json)?;
        lease.heartbeat(now_unix_millis, duration_millis)?;
        transaction.execute(
            "UPDATE leases SET lease_json = ?2, expires_at_unix_millis = ?3,
             updated_at_unix_millis = ?4 WHERE lease_id = ?1",
            params![
                lease_id.to_string(),
                serde_json::to_string(&lease)?,
                lease.expires_at_unix_millis(),
                now_unix_millis
            ],
        )?;
        transaction.commit()?;
        Ok(lease)
    }

    pub fn release_lease(&mut self, lease_id: LeaseId) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        Ok(self.connection.execute(
            "DELETE FROM leases WHERE lease_id = ?1",
            [lease_id.to_string()],
        )? == 1)
    }
}
