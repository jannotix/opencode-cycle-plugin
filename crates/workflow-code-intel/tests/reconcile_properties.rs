mod common;

use std::collections::{BTreeMap, BTreeSet};

use workflow_code_intel::{ReconcileCandidate, reconcile};
use workflow_core::ProjectId;

#[test]
fn deleting_every_owned_file_removes_all_owned_facts() {
    for count in 0..64 {
        let project = ProjectId::new();
        let names: Vec<_> = (0..count).map(|index| format!("symbol-{index}")).collect();
        let references: Vec<_> = names.iter().map(String::as_str).collect();
        let readable = common::partition(project, "src", &references);
        let result = reconcile(
            &readable,
            ReconcileCandidate {
                complete: true,
                edges: BTreeMap::new(),
                external_nodes: BTreeSet::new(),
                nodes: BTreeMap::new(),
                owned_files: BTreeSet::from(["src/lib.rs".to_owned()]),
                partition_id: readable.id,
            },
        )
        .unwrap();
        assert!(result.nodes.is_empty());
        assert!(result.edges.is_empty());
    }
}
