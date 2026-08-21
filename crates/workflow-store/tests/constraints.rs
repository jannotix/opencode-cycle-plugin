use std::num::NonZeroUsize;

use workflow_core::{ContentDigest, ProjectId, RequestRecord, WorkflowId, WorkflowTimestamp};
use workflow_store::{Store, StoreError};

#[test]
fn execution_constraint_is_durable_idempotent_and_write_once() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    store
        .save_request_once(
            workflow_id,
            ProjectId::new(),
            &RequestRecord::new("request".to_owned(), vec![]),
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let value = serde_json::json!({"required_checks":["existing_implementation"]});
    let digest = ContentDigest::of(&serde_json::to_vec(&value).unwrap());
    assert!(
        !store
            .save_constraint_once(
                workflow_id,
                "essentiality",
                digest,
                &value,
                WorkflowTimestamp::now()
            )
            .unwrap()
    );
    assert!(
        store
            .save_constraint_once(
                workflow_id,
                "essentiality",
                digest,
                &value,
                WorkflowTimestamp::now()
            )
            .unwrap()
    );
    assert_eq!(
        store.load_constraint(workflow_id, "essentiality").unwrap(),
        Some(value)
    );
    let replacement = serde_json::json!({"required_checks":[]});
    assert!(matches!(
        store.save_constraint_once(
            workflow_id,
            "essentiality",
            ContentDigest::of(&serde_json::to_vec(&replacement).unwrap()),
            &replacement,
            WorkflowTimestamp::now()
        ),
        Err(StoreError::AggregateConflict)
    ));
}
