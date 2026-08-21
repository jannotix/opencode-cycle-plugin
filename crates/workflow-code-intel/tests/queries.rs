mod common;

use std::collections::BTreeSet;

use workflow_code_intel::graph::{EdgeInput, EdgeKind, FactConfidence, FactProvider, GraphEdge};
use workflow_code_intel::{TraversalDirection, impact, neighbors, shortest_path};
use workflow_core::ProjectId;

#[test]
fn bounded_neighbors_paths_and_impact_have_stable_order() {
    let mut partition = common::partition(ProjectId::new(), "src", &["a", "b", "c", "d"]);
    let ids: Vec<_> = ["a", "b", "c", "d"]
        .map(|name| {
            partition
                .nodes
                .values()
                .find(|node| node.name == name)
                .unwrap()
                .id
        })
        .into();
    for (source, target) in [(ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[3])] {
        let edge = GraphEdge::new(EdgeInput {
            confidence: FactConfidence::Extracted,
            kind: EdgeKind::Calls,
            partition_id: partition.id,
            provider: FactProvider::Parser("rust".to_owned()),
            range: None,
            source,
            source_path: "src/lib.rs".to_owned(),
            target,
        })
        .unwrap();
        partition.edges.insert(edge.id, edge);
    }
    let path = shortest_path(&partition, ids[0], ids[3], 4, 100);
    assert_eq!(path.nodes, ids);
    assert!(!path.truncated);
    assert_eq!(
        neighbors(&partition, ids[0], TraversalDirection::Outgoing, 1)
            .nodes
            .len(),
        1
    );
    let impact = impact(
        &partition,
        &BTreeSet::from([ids[3]]),
        TraversalDirection::Incoming,
        2,
        3,
    );
    assert_eq!(impact.nodes.len(), 3);
    assert!(impact.truncated);
}

#[test]
fn infeasible_global_traversal_is_cut_off_explicitly() {
    let partition = common::partition(ProjectId::new(), "src", &["a", "b", "c"]);
    let ids: Vec<_> = partition
        .nodes
        .values()
        .filter(|node| node.name != "lib.rs")
        .map(|node| node.id)
        .collect();
    let result = shortest_path(&partition, ids[0], ids[2], 0, 1);
    assert!(result.nodes.is_empty());
    assert!(result.truncated);
}
