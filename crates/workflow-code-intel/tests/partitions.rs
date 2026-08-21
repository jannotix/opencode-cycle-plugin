mod common;

use std::num::NonZeroUsize;

use workflow_code_intel::graph::{GraphStore, GraphStoreError};
use workflow_core::{ProjectId, WorkflowTimestamp};

#[test]
fn replacing_one_partition_does_not_rewrite_another_and_removes_stale_facts() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("workflow.db");
    drop(workflow_store::Store::open(&path, NonZeroUsize::new(1).unwrap()).unwrap());
    let project = ProjectId::new();
    let first = common::partition(project, "frontend", &["one", "two"]);
    let second = common::partition(project, "backend", &["api"]);
    let timestamp = WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap();
    let mut store = GraphStore::open(&path).unwrap();
    assert_eq!(store.replace_partition(&first, true, timestamp).unwrap(), 1);
    assert_eq!(
        store.replace_partition(&second, true, timestamp).unwrap(),
        1
    );

    let smaller = common::partition(project, "frontend", &["one"]);
    assert_eq!(
        store.replace_partition(&smaller, true, timestamp).unwrap(),
        2
    );
    assert_eq!(store.load_partition(first.id).unwrap(), Some(smaller));
    assert_eq!(store.load_partition(second.id).unwrap(), Some(second));
}

#[test]
fn incomplete_candidate_never_replaces_the_readable_generation() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("workflow.db");
    drop(workflow_store::Store::open(&path, NonZeroUsize::new(1).unwrap()).unwrap());
    let project = ProjectId::new();
    let partition = common::partition(project, "src", &["stable"]);
    let timestamp = WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap();
    let mut store = GraphStore::open(&path).unwrap();
    store
        .replace_partition(&partition, true, timestamp)
        .unwrap();
    let candidate = common::partition(project, "src", &["incomplete"]);
    assert!(matches!(
        store.replace_partition(&candidate, false, timestamp),
        Err(GraphStoreError::Incomplete)
    ));
    assert_eq!(store.load_partition(partition.id).unwrap(), Some(partition));
}
