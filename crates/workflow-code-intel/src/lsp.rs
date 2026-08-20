use std::collections::BTreeMap;

use crate::graph::{
    EdgeId, FactConfidence, FactProvider, GraphEdge, GraphNode, GraphPartition, NodeId, PartitionId,
};

pub struct LspFactBatch {
    pub edges: BTreeMap<EdgeId, GraphEdge>,
    pub nodes: BTreeMap<NodeId, GraphNode>,
    pub partition_id: PartitionId,
    pub provider: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LspMergeError {
    InvalidConfidence,
    InvalidPartition,
    InvalidProvider,
}

impl std::fmt::Display for LspMergeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidConfidence => "language server facts must be marked inferred",
            Self::InvalidPartition => "language server facts belong to another partition",
            Self::InvalidProvider => "language server fact provider identity is invalid",
        })
    }
}

impl std::error::Error for LspMergeError {}

pub fn merge_lsp_facts(
    partition: &mut GraphPartition,
    batch: LspFactBatch,
) -> Result<(), LspMergeError> {
    if batch.partition_id != partition.id {
        return Err(LspMergeError::InvalidPartition);
    }
    if batch.provider.trim().is_empty() {
        return Err(LspMergeError::InvalidProvider);
    }
    let provider_matches = |provider: &FactProvider| matches!(provider, FactProvider::LanguageServer(identity) if identity == &batch.provider);
    if batch.nodes.values().any(|node| {
        node.partition_id != partition.id
            || node.confidence != FactConfidence::Inferred
            || !provider_matches(&node.provider)
    }) || batch.edges.values().any(|edge| {
        edge.partition_id != partition.id
            || edge.confidence != FactConfidence::Inferred
            || !provider_matches(&edge.provider)
    }) {
        return Err(LspMergeError::InvalidConfidence);
    }
    for (id, node) in batch.nodes {
        partition.nodes.entry(id).or_insert(node);
    }
    for (id, edge) in batch.edges {
        partition.edges.entry(id).or_insert(edge);
    }
    partition
        .validate()
        .map_err(|_| LspMergeError::InvalidPartition)
}
