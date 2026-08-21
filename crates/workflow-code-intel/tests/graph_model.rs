mod common;

use std::str::FromStr;

use workflow_code_intel::graph::{
    FactConfidence, FactProvider, GraphError, GraphNode, NodeInput, NodeKind, PartitionId,
    SourceRange,
};
use workflow_core::ProjectId;

#[test]
fn identifiers_are_stable_and_provenance_remains_explicit() {
    let project = ProjectId::new();
    let partition = PartitionId::new(project, "src");
    let first = GraphNode::new(NodeInput {
        confidence: FactConfidence::Extracted,
        kind: NodeKind::Symbol,
        name: "run".to_owned(),
        partition_id: partition,
        provider: FactProvider::Parser("rust".to_owned()),
        qualified_name: "crate::run".to_owned(),
        range: Some(SourceRange {
            end_byte: 20,
            end_column: 20,
            end_line: 1,
            start_byte: 10,
            start_column: 10,
            start_line: 1,
        }),
        source_path: "src/lib.rs".to_owned(),
    })
    .unwrap();
    let moved = GraphNode::new(NodeInput {
        confidence: FactConfidence::Inferred,
        kind: NodeKind::Symbol,
        name: "run".to_owned(),
        partition_id: partition,
        provider: FactProvider::LanguageServer("rust-analyzer".to_owned()),
        qualified_name: "crate::run".to_owned(),
        range: None,
        source_path: "src/lib.rs".to_owned(),
    })
    .unwrap();
    assert_eq!(first.id, moved.id);
    assert_ne!(first.confidence, moved.confidence);
    assert_ne!(first.provider, moved.provider);
}

#[test]
fn invalid_ranges_paths_and_edges_are_rejected() {
    let project = ProjectId::new();
    let partition_id = PartitionId::new(project, "src");
    assert_eq!(
        GraphNode::new(NodeInput {
            confidence: FactConfidence::Extracted,
            kind: NodeKind::Symbol,
            name: "x".to_owned(),
            partition_id,
            provider: FactProvider::Manifest,
            qualified_name: "x".to_owned(),
            range: None,
            source_path: "../outside".to_owned(),
        })
        .unwrap_err(),
        GraphError::UnsafePath
    );
    let mut partition = common::partition(project, "src", &["run"]);
    let edge = partition.edges.values_mut().next().unwrap();
    edge.target = common::partition(ProjectId::new(), "other", &["x"])
        .nodes
        .values()
        .next()
        .unwrap()
        .id;
    assert_eq!(partition.validate(), Err(GraphError::InvalidEdge));
}

#[test]
fn protocol_v1_code_graph_identifier_has_a_fixed_vector() {
    let project = ProjectId::from_str("0190f0a0-0000-7000-8000-000000000010").unwrap();
    let partition = PartitionId::new(project, "src");
    assert_eq!(
        partition.to_string(),
        "6b7dac4a8346903e5b6ccb6d753fd7b446f5e1b632167de27e3dcb021fc8c5dd"
    );
}
