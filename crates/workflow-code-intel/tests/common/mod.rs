use std::collections::BTreeMap;

use workflow_code_intel::graph::{
    EdgeInput, EdgeKind, FactConfidence, FactProvider, GraphEdge, GraphNode, GraphPartition,
    NodeInput, NodeKind, PartitionId, SourceRange,
};
use workflow_core::ProjectId;

pub fn partition(project_id: ProjectId, scope: &str, symbols: &[&str]) -> GraphPartition {
    let partition_id = PartitionId::new(project_id, scope);
    let file = GraphNode::new(NodeInput {
        confidence: FactConfidence::Extracted,
        kind: NodeKind::File,
        name: "lib.rs".to_owned(),
        partition_id,
        provider: FactProvider::Manifest,
        qualified_name: format!("{scope}/lib.rs"),
        range: None,
        source_path: format!("{scope}/lib.rs"),
    })
    .unwrap();
    let mut nodes = BTreeMap::from([(file.id, file.clone())]);
    let mut edges = BTreeMap::new();
    for (index, name) in symbols.iter().enumerate() {
        let symbol = GraphNode::new(NodeInput {
            confidence: FactConfidence::Extracted,
            kind: NodeKind::Symbol,
            name: (*name).to_owned(),
            partition_id,
            provider: FactProvider::Parser("rust".to_owned()),
            qualified_name: format!("crate::{name}"),
            range: Some(SourceRange {
                end_byte: u64::try_from(index + 2).unwrap(),
                end_column: u32::try_from(index + 2).unwrap(),
                end_line: 1,
                start_byte: u64::try_from(index + 1).unwrap(),
                start_column: u32::try_from(index + 1).unwrap(),
                start_line: 1,
            }),
            source_path: format!("{scope}/lib.rs"),
        })
        .unwrap();
        let edge = GraphEdge::new(EdgeInput {
            confidence: FactConfidence::Extracted,
            kind: EdgeKind::Contains,
            partition_id,
            provider: FactProvider::Parser("rust".to_owned()),
            range: symbol.range,
            source: file.id,
            source_path: format!("{scope}/lib.rs"),
            target: symbol.id,
        })
        .unwrap();
        nodes.insert(symbol.id, symbol);
        edges.insert(edge.id, edge);
    }
    GraphPartition {
        edges,
        external_nodes: Default::default(),
        id: partition_id,
        nodes,
        project_id,
        scope: scope.to_owned(),
    }
}
