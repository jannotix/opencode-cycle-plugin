use serde_json::{Value, json};
use workflow_core::ProjectId;
use workflow_ipc::protocol::HistoryOperation;
use workflow_ledger::{
    ChainVerification, CheckpointKey, CheckpointVerification, HistoryExport, HistoryFilter, query,
};
use workflow_store::{Store, StoreError};

#[derive(Debug)]
pub enum HistoryError {
    InvalidLedger,
    InvalidProject,
    Serialization(serde_json::Error),
    Store(StoreError),
}

impl std::fmt::Display for HistoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidLedger => formatter.write_str("stored ledger verification failed"),
            Self::InvalidProject => formatter.write_str("project key cannot be empty"),
            Self::Serialization(error) => error.fmt(formatter),
            Self::Store(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for HistoryError {}

impl From<StoreError> for HistoryError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}

impl From<serde_json::Error> for HistoryError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value)
    }
}

pub fn verify_store(store: &Store, key: &CheckpointKey) -> Result<(), HistoryError> {
    let chain = store.load_ledger()?;
    if !matches!(chain.verify(None), ChainVerification::Valid { .. }) {
        return Err(HistoryError::InvalidLedger);
    }
    for checkpoint in store.load_checkpoints()? {
        let entry = usize::try_from(checkpoint.sequence)
            .ok()
            .and_then(|index| chain.entries().get(index))
            .map(|entry| (entry.sequence, entry.hash));
        if checkpoint.verify(Some(&key.verifying_key()), entry) != CheckpointVerification::Valid {
            return Err(HistoryError::InvalidLedger);
        }
    }
    Ok(())
}

pub fn execute(
    store: &Store,
    project_key: &str,
    operation: HistoryOperation,
    key: &CheckpointKey,
) -> Result<Value, HistoryError> {
    if project_key.trim().is_empty() {
        return Err(HistoryError::InvalidProject);
    }
    let chain = store.load_ledger()?;
    match operation {
        HistoryOperation::Query {
            after_sequence,
            limit,
        } => Ok(serde_json::to_value(query(
            &chain,
            &HistoryFilter {
                project_id: Some(ProjectId::from_stable_key(project_key)),
                ..HistoryFilter::default()
            },
            after_sequence,
            limit,
        ))?),
        HistoryOperation::Verify => {
            let chain_status = chain.verify(None);
            let checkpoints: Vec<_> = store
                .load_checkpoints()?
                .into_iter()
                .map(|checkpoint| {
                    let head = usize::try_from(checkpoint.sequence)
                        .ok()
                        .and_then(|index| chain.entries().get(index))
                        .map(|entry| (entry.sequence, entry.hash));
                    json!({
                        "sequence": checkpoint.sequence,
                        "status": checkpoint_status(checkpoint.verify(Some(&key.verifying_key()), head)),
                    })
                })
                .collect();
            Ok(json!({
                "chain": chain_status_value(chain_status),
                "checkpoints": checkpoints,
            }))
        }
        HistoryOperation::Export => Ok(serde_json::to_value(HistoryExport::new(
            &chain,
            store.load_checkpoints()?,
        ))?),
    }
}

fn chain_status_value(status: ChainVerification) -> Value {
    match status {
        ChainVerification::Valid { entries, head } => json!({
            "entries": entries,
            "head": head.map(|digest| digest.to_string()),
            "status": "valid",
        }),
        ChainVerification::Broken { reason, sequence } => json!({
            "reason": format!("{reason:?}").to_ascii_lowercase(),
            "sequence": sequence,
            "status": "broken",
        }),
        ChainVerification::HeadMismatch { actual, expected } => json!({
            "actual": actual.map(|digest| digest.to_string()),
            "expected": expected.map(|digest| digest.to_string()),
            "status": "head_mismatch",
        }),
    }
}

const fn checkpoint_status(status: CheckpointVerification) -> &'static str {
    match status {
        CheckpointVerification::HeadMismatch => "head_mismatch",
        CheckpointVerification::InvalidPublicKey => "invalid_public_key",
        CheckpointVerification::InvalidSignature => "invalid_signature",
        CheckpointVerification::MissingKey => "missing_key",
        CheckpointVerification::Valid => "valid",
        CheckpointVerification::WrongKey => "wrong_key",
    }
}
