use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use workflow_core::{ContentDigest, ProjectId};

// Immutable protocol-v1 compatibility identifier for persisted code-graph digests.
const LEGACY_PROTOCOL_V1_CODE_GRAPH_DOMAIN: &[u8] = b"opencode-workflow/code-graph/v1";

macro_rules! digest_id {
    ($name:ident) => {
        #[derive(
            Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize,
        )]
        #[serde(transparent)]
        pub struct $name(ContentDigest);

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

digest_id!(PartitionId);
digest_id!(NodeId);
digest_id!(EdgeId);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FactConfidence {
    Extracted,
    Inferred,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "identity", rename_all = "snake_case")]
pub enum FactProvider {
    Inference(String),
    LanguageServer(String),
    Manifest,
    Parser(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceRange {
    pub end_byte: u64,
    pub end_column: u32,
    pub end_line: u32,
    pub start_byte: u64,
    pub start_column: u32,
    pub start_line: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Configuration,
    File,
    Module,
    Route,
    Schema,
    Symbol,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Calls,
    Configures,
    Contains,
    Defines,
    DependsOn,
    Implements,
    Imports,
    Inherits,
    RoutesTo,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GraphNode {
    pub confidence: FactConfidence,
    pub id: NodeId,
    pub kind: NodeKind,
    pub name: String,
    pub partition_id: PartitionId,
    pub provider: FactProvider,
    pub qualified_name: String,
    pub range: Option<SourceRange>,
    pub source_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GraphEdge {
    pub confidence: FactConfidence,
    pub id: EdgeId,
    pub kind: EdgeKind,
    pub partition_id: PartitionId,
    pub provider: FactProvider,
    pub range: Option<SourceRange>,
    pub source: NodeId,
    pub source_path: String,
    pub target: NodeId,
}

pub struct NodeInput {
    pub confidence: FactConfidence,
    pub kind: NodeKind,
    pub name: String,
    pub partition_id: PartitionId,
    pub provider: FactProvider,
    pub qualified_name: String,
    pub range: Option<SourceRange>,
    pub source_path: String,
}

pub struct EdgeInput {
    pub confidence: FactConfidence,
    pub kind: EdgeKind,
    pub partition_id: PartitionId,
    pub provider: FactProvider,
    pub range: Option<SourceRange>,
    pub source: NodeId,
    pub source_path: String,
    pub target: NodeId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GraphPartition {
    pub edges: BTreeMap<EdgeId, GraphEdge>,
    pub external_nodes: BTreeSet<NodeId>,
    pub id: PartitionId,
    pub nodes: BTreeMap<NodeId, GraphNode>,
    pub project_id: ProjectId,
    pub scope: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphError {
    EmptyIdentity,
    InvalidEdge,
    InvalidPartition,
    InvalidRange,
    UnsafePath,
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::EmptyIdentity => "graph fact identity cannot be empty",
            Self::InvalidEdge => "graph edge references an unknown node",
            Self::InvalidPartition => "graph fact belongs to another partition",
            Self::InvalidRange => "graph source range is invalid",
            Self::UnsafePath => "graph source path must be relative and traversal-free",
        })
    }
}

impl std::error::Error for GraphError {}

impl PartitionId {
    #[must_use]
    pub fn new(project_id: ProjectId, scope: &str) -> Self {
        Self(digest(&["partition", &project_id.to_string(), scope]))
    }
}

impl GraphNode {
    pub fn new(input: NodeInput) -> Result<Self, GraphError> {
        validate_identity(
            &input.name,
            &input.qualified_name,
            &input.source_path,
            input.range,
        )?;
        let id = NodeId(digest(&[
            "node",
            &input.partition_id.to_string(),
            &format!("{:?}", input.kind),
            &input.qualified_name,
            &input.source_path,
        ]));
        Ok(Self {
            confidence: input.confidence,
            id,
            kind: input.kind,
            name: input.name,
            partition_id: input.partition_id,
            provider: input.provider,
            qualified_name: input.qualified_name,
            range: input.range,
            source_path: input.source_path,
        })
    }
}

impl GraphEdge {
    pub fn new(input: EdgeInput) -> Result<Self, GraphError> {
        validate_identity("edge", "edge", &input.source_path, input.range)?;
        let id = EdgeId(digest(&[
            "edge",
            &input.partition_id.to_string(),
            &format!("{:?}", input.kind),
            &input.source.to_string(),
            &input.target.to_string(),
        ]));
        Ok(Self {
            confidence: input.confidence,
            id,
            kind: input.kind,
            partition_id: input.partition_id,
            provider: input.provider,
            range: input.range,
            source: input.source,
            source_path: input.source_path,
            target: input.target,
        })
    }
}

impl GraphPartition {
    pub fn validate(&self) -> Result<(), GraphError> {
        if self.scope.trim().is_empty() || self.id != PartitionId::new(self.project_id, &self.scope)
        {
            return Err(GraphError::InvalidPartition);
        }
        if self
            .nodes
            .iter()
            .any(|(id, node)| *id != node.id || node.partition_id != self.id)
            || self
                .edges
                .iter()
                .any(|(id, edge)| *id != edge.id || edge.partition_id != self.id)
        {
            return Err(GraphError::InvalidPartition);
        }
        let known = |id: &NodeId| self.nodes.contains_key(id) || self.external_nodes.contains(id);
        if self
            .edges
            .values()
            .any(|edge| !known(&edge.source) || !known(&edge.target))
        {
            return Err(GraphError::InvalidEdge);
        }
        Ok(())
    }
}

fn validate_identity(
    name: &str,
    qualified_name: &str,
    source_path: &str,
    range: Option<SourceRange>,
) -> Result<(), GraphError> {
    if name.trim().is_empty() || qualified_name.trim().is_empty() {
        return Err(GraphError::EmptyIdentity);
    }
    let path = std::path::Path::new(source_path);
    if source_path.is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return Err(GraphError::UnsafePath);
    }
    if range.is_some_and(|range| {
        range.start_byte > range.end_byte
            || (range.start_line, range.start_column) > (range.end_line, range.end_column)
    }) {
        return Err(GraphError::InvalidRange);
    }
    Ok(())
}

fn digest(parts: &[&str]) -> ContentDigest {
    let mut bytes = LEGACY_PROTOCOL_V1_CODE_GRAPH_DOMAIN.to_vec();
    for part in parts {
        bytes.extend_from_slice(&u64::try_from(part.len()).unwrap_or(u64::MAX).to_be_bytes());
        bytes.extend_from_slice(part.as_bytes());
    }
    ContentDigest::of(&bytes)
}
