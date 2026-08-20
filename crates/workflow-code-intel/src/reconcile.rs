use std::collections::{BTreeMap, BTreeSet};

use crate::graph::{EdgeId, GraphEdge, GraphError, GraphNode, GraphPartition, NodeId, PartitionId};

pub struct ReconcileCandidate {
    pub complete: bool,
    pub edges: BTreeMap<EdgeId, GraphEdge>,
    pub external_nodes: BTreeSet<NodeId>,
    pub nodes: BTreeMap<NodeId, GraphNode>,
    pub owned_files: BTreeSet<String>,
    pub partition_id: PartitionId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReconcileError {
    Domain(GraphError),
    Incomplete,
    InvalidPartition,
}

impl std::fmt::Display for ReconcileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Domain(error) => error.fmt(formatter),
            Self::Incomplete => {
                formatter.write_str("incomplete facts cannot replace readable graph data")
            }
            Self::InvalidPartition => {
                formatter.write_str("reconciliation candidate belongs to another partition")
            }
        }
    }
}

impl std::error::Error for ReconcileError {}

pub fn reconcile(
    readable: &GraphPartition,
    candidate: ReconcileCandidate,
) -> Result<GraphPartition, ReconcileError> {
    if !candidate.complete {
        return Err(ReconcileError::Incomplete);
    }
    if candidate.partition_id != readable.id
        || candidate
            .nodes
            .values()
            .any(|node| node.partition_id != readable.id)
        || candidate
            .edges
            .values()
            .any(|edge| edge.partition_id != readable.id)
    {
        return Err(ReconcileError::InvalidPartition);
    }
    let removed_nodes: BTreeSet<_> = readable
        .nodes
        .values()
        .filter(|node| candidate.owned_files.contains(&node.source_path))
        .map(|node| node.id)
        .collect();
    let mut nodes = readable.nodes.clone();
    nodes.retain(|_, node| !candidate.owned_files.contains(&node.source_path));
    nodes.extend(candidate.nodes);
    let mut edges = readable.edges.clone();
    edges.retain(|_, edge| {
        !candidate.owned_files.contains(&edge.source_path)
            && !removed_nodes.contains(&edge.source)
            && !removed_nodes.contains(&edge.target)
    });
    edges.extend(candidate.edges);
    let mut external_nodes = readable.external_nodes.clone();
    external_nodes.extend(candidate.external_nodes);
    external_nodes.retain(|node| !nodes.contains_key(node));
    let result = GraphPartition {
        edges,
        external_nodes,
        id: readable.id,
        nodes,
        project_id: readable.project_id,
        scope: readable.scope.clone(),
    };
    result.validate().map_err(ReconcileError::Domain)?;
    Ok(result)
}
