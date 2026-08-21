use std::num::NonZeroUsize;

use workflow_core::{ContentDigest, ProjectId, RequestRecord, WorkflowId, WorkflowTimestamp};
use workflow_store::{Store, StoreError};

#[test]
fn immutable_request_survives_restart_and_rejects_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workflow.db");
    let workflow_id = WorkflowId::new();
    let project_id = ProjectId::from_stable_key("project");
    let request = RequestRecord::new(
        "Build backend and frontend".to_owned(),
        vec![ContentDigest::of(b"attachment")],
    );
    let mut store = Store::open(&path, NonZeroUsize::new(1).unwrap()).unwrap();
    assert!(
        !store
            .save_request_once(workflow_id, project_id, &request, WorkflowTimestamp::now())
            .unwrap()
    );
    assert!(
        store
            .save_request_once(workflow_id, project_id, &request, WorkflowTimestamp::now())
            .unwrap()
    );
    assert!(matches!(
        store.save_request_once(
            workflow_id,
            project_id,
            &RequestRecord::new("Architect summary".to_owned(), vec![]),
            WorkflowTimestamp::now()
        ),
        Err(StoreError::AggregateConflict)
    ));
    drop(store);

    let restarted = Store::open(&path, NonZeroUsize::new(1).unwrap()).unwrap();
    assert_eq!(
        restarted.load_request(workflow_id).unwrap(),
        Some((project_id, request))
    );
}

#[test]
fn latest_project_workflow_is_scoped_and_deterministic() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let project = ProjectId::from_stable_key("project");
    let other = ProjectId::from_stable_key("other");
    let first = WorkflowId::new();
    let second = WorkflowId::new();
    let request = RequestRecord::new("Request".to_owned(), vec![]);
    store
        .save_request_once(
            first,
            project,
            &request,
            WorkflowTimestamp::parse("2026-08-12T10:00:00Z").unwrap(),
        )
        .unwrap();
    store
        .save_request_once(
            second,
            project,
            &request,
            WorkflowTimestamp::parse("2026-08-12T11:00:00Z").unwrap(),
        )
        .unwrap();

    assert_eq!(
        store.latest_workflow_for_project(project).unwrap(),
        Some(second)
    );
    assert_eq!(store.latest_workflow_for_project(other).unwrap(), None);
}
