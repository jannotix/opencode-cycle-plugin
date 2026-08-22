use std::num::NonZeroUsize;

use workflow_core::{ProjectId, RequestRecord, WorkflowId, WorkflowTimestamp};
use workflow_store::{Store, StoreError, WorktreeBinding};

#[test]
fn daemon_worktree_binding_is_durable_idempotent_and_write_once() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("workflow.db");
    let workflow_id = WorkflowId::new();
    let project_id = ProjectId::from_stable_key("project");
    let other_project = ProjectId::from_stable_key("other-project");
    let binding = WorktreeBinding {
        base_revision: "1".repeat(40),
        path: directory
            .path()
            .join("managed")
            .to_string_lossy()
            .into_owned(),
        project_id,
        workflow_id,
    };
    let mut store = Store::open(&database, NonZeroUsize::new(1).unwrap()).unwrap();
    store
        .save_request_once(
            workflow_id,
            project_id,
            &RequestRecord::new("request".to_owned(), vec![]),
            WorkflowTimestamp::now(),
        )
        .unwrap();

    assert!(
        !store
            .save_worktree_binding_once(&binding, WorkflowTimestamp::now())
            .unwrap()
    );
    assert!(
        store
            .save_worktree_binding_once(&binding, WorkflowTimestamp::now())
            .unwrap()
    );
    assert!(matches!(
        store.save_worktree_binding_once(
            &WorktreeBinding {
                base_revision: "2".repeat(40),
                ..binding.clone()
            },
            WorkflowTimestamp::now()
        ),
        Err(StoreError::AggregateConflict)
    ));
    assert!(matches!(
        store.save_worktree_binding_once(
            &WorktreeBinding {
                project_id: other_project,
                ..binding.clone()
            },
            WorkflowTimestamp::now()
        ),
        Err(StoreError::AggregateConflict)
    ));
    drop(store);

    let restarted = Store::open(&database, NonZeroUsize::new(1).unwrap()).unwrap();
    assert_eq!(
        restarted.load_worktree_binding(workflow_id).unwrap(),
        Some(binding)
    );
}
