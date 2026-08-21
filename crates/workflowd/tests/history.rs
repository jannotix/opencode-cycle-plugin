use std::{collections::BTreeMap, num::NonZeroUsize};

use tempfile::TempDir;
use workflow_ipc::{
    audit::{AuditData, AuditObservation},
    protocol::HistoryOperation,
};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

fn observation(project_key: &str) -> AuditObservation {
    AuditObservation {
        actor_id: "test".to_owned(),
        candidate_id: None,
        data: AuditData::Workflow {
            action: "started".to_owned(),
        },
        evidence_ids: Default::default(),
        files: Default::default(),
        metadata: BTreeMap::new(),
        model: None,
        project_key: project_key.to_owned(),
        role: None,
        session_id: Some("session".to_owned()),
        task_id: None,
        timestamp_unix_millis: 1_786_519_330_123,
        workflow_id: None,
    }
}

#[test]
fn history_query_is_project_scoped_and_checkpointed() {
    let temporary = TempDir::new().unwrap();
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    let key = CheckpointKey::from_seed(&[7; 32]);
    workflowd::audit::record(&mut store, &key, observation("one")).unwrap();
    workflowd::audit::record(&mut store, &key, observation("two")).unwrap();

    workflowd::history::verify_store(&store, &key).unwrap();
    let result = workflowd::history::execute(
        &store,
        "two",
        HistoryOperation::Query {
            after_sequence: None,
            limit: 10,
        },
        &key,
    )
    .unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    assert_eq!(result["entries"][0]["sequence"], 1);
}

#[test]
fn changed_history_and_replaced_key_fail_verification() {
    let temporary = TempDir::new().unwrap();
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    let key = CheckpointKey::from_seed(&[7; 32]);
    workflowd::audit::record(&mut store, &key, observation("one")).unwrap();
    assert!(workflowd::history::verify_store(&store, &CheckpointKey::from_seed(&[8; 32])).is_err());

    store
        .writer()
        .unwrap()
        .execute(
            "UPDATE ledger_entries SET event_json = replace(event_json, 'started', 'changed')",
            [],
        )
        .unwrap();
    assert!(workflowd::history::verify_store(&store, &key).is_err());
}
