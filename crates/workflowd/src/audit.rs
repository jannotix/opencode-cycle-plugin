use workflow_core::{ProjectId, WorkflowTimestamp};
use workflow_ipc::audit::{AuditData, AuditObservation};
use workflow_ledger::{
    Actor, Checkpoint, CheckpointKey, EventData, LedgerEntry, LedgerEvent, ModelIdentity, Redactor,
};
use workflow_store::{Store, StoreError};

#[derive(Debug)]
pub enum AuditError {
    Event(workflow_ledger::EventError),
    InvalidTimestamp,
    Store(StoreError),
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Event(error) => error.fmt(formatter),
            Self::InvalidTimestamp => {
                formatter.write_str("audit timestamp is outside the supported range")
            }
            Self::Store(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for AuditError {}

pub fn record(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    observation: AuditObservation,
) -> Result<LedgerEntry, AuditError> {
    let timestamp = i128::from(observation.timestamp_unix_millis)
        .checked_mul(1_000_000)
        .and_then(|value| WorkflowTimestamp::from_unix_timestamp_nanos(value).ok())
        .ok_or(AuditError::InvalidTimestamp)?;
    let data = match observation.data {
        AuditData::Workflow { action } => EventData::Workflow { action },
        AuditData::Tool {
            invocation_digest,
            tool,
        } => EventData::Tool {
            invocation_digest: invocation_digest.to_string(),
            tool,
        },
        AuditData::Permission {
            decision,
            permission,
        } => EventData::Permission {
            decision,
            permission,
        },
        AuditData::Git {
            externally_attributed,
            revision,
        } => EventData::Git {
            externally_attributed,
            revision,
        },
        AuditData::Verification { gate, status } => EventData::Verification { gate, status },
    };
    let event = LedgerEvent::new(
        Actor {
            id: observation.actor_id,
            model: observation.model.map(|model| ModelIdentity {
                model: model.model,
                provider: model.provider,
            }),
            role: observation.role,
            session_id: observation.session_id,
        },
        observation.candidate_id,
        data,
        observation.evidence_ids,
        observation.files,
        observation.metadata,
        ProjectId::from_stable_key(&observation.project_key),
        observation.task_id,
        timestamp,
        observation.workflow_id,
        &Redactor::default(),
    )
    .map_err(AuditError::Event)?;
    let entry = store
        .append_ledger_event(event)
        .map_err(AuditError::Store)?;
    if entry.sequence % 100 == 0 {
        let checkpoint = Checkpoint::sign(
            entry.sequence,
            entry.hash,
            entry.event.timestamp,
            checkpoint_key,
        );
        store
            .save_checkpoint(&checkpoint)
            .map_err(AuditError::Store)?;
    }
    Ok(entry)
}
