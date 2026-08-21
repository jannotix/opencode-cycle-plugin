mod common;

use std::collections::{BTreeMap, BTreeSet};

use workflow_code_intel::{ReconcileCandidate, ReconcileError, reconcile};
use workflow_core::ProjectId;

#[test]
fn changed_file_replaces_only_owned_facts_and_deleted_symbols_disappear() {
    let project = ProjectId::new();
    let readable = common::partition(project, "src", &["keep", "remove"]);
    let keep = readable
        .nodes
        .values()
        .find(|node| node.name == "keep")
        .unwrap()
        .clone();
    let changed = common::partition(project, "src", &["replacement"]);
    let result = reconcile(
        &readable,
        ReconcileCandidate {
            complete: true,
            edges: changed.edges,
            external_nodes: BTreeSet::new(),
            nodes: changed.nodes,
            owned_files: BTreeSet::from(["src/lib.rs".to_owned()]),
            partition_id: readable.id,
        },
    )
    .unwrap();
    assert!(result.nodes.values().all(|node| node.name != "remove"));
    assert!(result.nodes.values().any(|node| node.name == "replacement"));
    assert!(!result.nodes.contains_key(&keep.id));
}

#[test]
fn incomplete_candidate_preserves_readable_graph() {
    let project = ProjectId::new();
    let readable = common::partition(project, "src", &["stable"]);
    assert_eq!(
        reconcile(
            &readable,
            ReconcileCandidate {
                complete: false,
                edges: BTreeMap::new(),
                external_nodes: BTreeSet::new(),
                nodes: BTreeMap::new(),
                owned_files: BTreeSet::from(["src/lib.rs".to_owned()]),
                partition_id: readable.id,
            },
        ),
        Err(ReconcileError::Incomplete)
    );
    assert_eq!(readable.nodes.len(), 2);
}
