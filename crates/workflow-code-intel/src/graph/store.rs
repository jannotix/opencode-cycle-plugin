use std::{path::Path, time::Duration};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use workflow_core::{ProjectId, WorkflowTimestamp};

use crate::{
    Manifest, ManifestEntry,
    graph::{
        EdgeInput, EdgeKind, FactConfidence, FactProvider, GraphEdge, GraphError, GraphNode,
        GraphPartition, NodeInput, NodeKind, PartitionId, SourceRange,
    },
};

pub struct GraphStore {
    connection: Connection,
}

pub struct PartitionBatch<'connection> {
    timestamp: WorkflowTimestamp,
    transaction: Transaction<'connection>,
}

const CACHE_SIZE_KIB: i64 = 64 * 1_024;
// SQLite's application_id is a database-format boundary independent from the
// schema version. OWF1 certifies that every graph row uses predecessor-readable
// full v1 JSON; zero requires the atomic recovery pass below.
const FULL_V1_APPLICATION_ID: i64 = 0x4f57_4631;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct StoredGraphNode {
    confidence: FactConfidence,
    kind: NodeKind,
    name: String,
    provider: FactProvider,
    qualified_name: String,
    range: Option<SourceRange>,
    source_path: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct StoredGraphEdge {
    confidence: FactConfidence,
    kind: EdgeKind,
    provider: FactProvider,
    range: Option<SourceRange>,
    source: crate::graph::NodeId,
    source_path: String,
    target: crate::graph::NodeId,
}

#[derive(Debug)]
pub enum GraphStoreError {
    Domain(GraphError),
    Incomplete,
    IntegerRange,
    MissingSchema,
    Serialization(serde_json::Error),
    Sqlite(rusqlite::Error),
    UnsupportedApplicationId(i64),
}

impl std::fmt::Display for GraphStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Domain(error) => error.fmt(formatter),
            Self::Incomplete => formatter
                .write_str("incomplete graph candidate cannot replace a readable partition"),
            Self::IntegerRange => {
                formatter.write_str("graph generation is outside the supported range")
            }
            Self::MissingSchema => formatter.write_str("code intelligence schema is unavailable"),
            Self::Serialization(error) => error.fmt(formatter),
            Self::Sqlite(error) => error.fmt(formatter),
            Self::UnsupportedApplicationId(value) => {
                write!(
                    formatter,
                    "unsupported graph storage application id: {value}"
                )
            }
        }
    }
}

impl std::error::Error for GraphStoreError {}

impl From<GraphError> for GraphStoreError {
    fn from(value: GraphError) -> Self {
        Self::Domain(value)
    }
}

impl From<rusqlite::Error> for GraphStoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<serde_json::Error> for GraphStoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value)
    }
}

impl GraphStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GraphStoreError> {
        let mut connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "trusted_schema", "OFF")?;
        connection.pragma_update(None, "cache_size", -CACHE_SIZE_KIB)?;
        connection.pragma_update(None, "temp_store", "MEMORY")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version < 5 {
            return Err(GraphStoreError::MissingSchema);
        }
        restore_full_v1_compatibility(&mut connection)?;
        Ok(Self { connection })
    }

    pub fn replace_partition(
        &mut self,
        partition: &GraphPartition,
        complete: bool,
        timestamp: WorkflowTimestamp,
    ) -> Result<u64, GraphStoreError> {
        self.replace(partition, complete, timestamp, |_| Ok(()))
    }

    pub fn partition_batch(
        &mut self,
        timestamp: WorkflowTimestamp,
    ) -> Result<PartitionBatch<'_>, GraphStoreError> {
        Ok(PartitionBatch {
            timestamp,
            transaction: self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?,
        })
    }

    pub fn load_manifest(&self, project_id: ProjectId) -> Result<Manifest, GraphStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT entry_json FROM code_manifest WHERE project_id = ?1 ORDER BY relative_path",
        )?;
        let rows = statement.query_map([project_id.to_string()], |row| row.get::<_, String>(0))?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(serde_json::from_str::<ManifestEntry>(&row?)?);
        }
        Ok(Manifest::from_entries(entries))
    }

    pub fn reset_project(&mut self, project_id: ProjectId) -> Result<(), GraphStoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM code_manifest WHERE project_id = ?1",
            [project_id.to_string()],
        )?;
        transaction.execute(
            "DELETE FROM code_paths_fts WHERE project_id = ?1",
            [project_id.to_string()],
        )?;
        transaction.execute(
            "DELETE FROM code_partitions WHERE project_id = ?1",
            [project_id.to_string()],
        )?;
        transaction.execute(
            "DELETE FROM code_index_state WHERE project_id = ?1",
            [project_id.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn replace_manifest_scopes(
        &mut self,
        project_id: ProjectId,
        scopes: &std::collections::BTreeSet<String>,
        entries: &[ManifestEntry],
    ) -> Result<(), GraphStoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        replace_manifest_scopes_in_transaction(&transaction, project_id, scopes, entries)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn load_index_state(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<(String, String)>, GraphStoreError> {
        self.connection
            .query_row(
                "SELECT repository_path, fingerprint FROM code_index_state WHERE project_id = ?1",
                [project_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(GraphStoreError::Sqlite)
    }

    pub fn save_index_state(
        &self,
        project_id: ProjectId,
        repository_path: &str,
        fingerprint: &str,
        timestamp: WorkflowTimestamp,
    ) -> Result<(), GraphStoreError> {
        self.connection.execute(
            "INSERT INTO code_index_state(project_id, repository_path, fingerprint, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id) DO UPDATE SET
               repository_path = excluded.repository_path,
               fingerprint = excluded.fingerprint,
               updated_at = excluded.updated_at",
            params![
                project_id.to_string(),
                repository_path,
                fingerprint,
                timestamp.to_string(),
            ],
        )?;
        Ok(())
    }

    pub fn search_paths(
        &self,
        project_id: ProjectId,
        terms: &[String],
        limit: usize,
    ) -> Result<Vec<String>, GraphStoreError> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let query = terms
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut statement = self.connection.prepare(
            "SELECT relative_path FROM code_paths_fts
             WHERE project_id = ?1 AND code_paths_fts MATCH ?2
             ORDER BY rank LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                project_id.to_string(),
                query,
                i64::try_from(limit).unwrap_or(i64::MAX),
            ],
            |row| row.get::<_, String>(0),
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(GraphStoreError::Sqlite)
    }

    pub fn project_scopes(
        &self,
        project_id: ProjectId,
        limit: usize,
    ) -> Result<Vec<String>, GraphStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT scope FROM code_partitions WHERE project_id = ?1 ORDER BY scope LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![
                project_id.to_string(),
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |row| row.get::<_, String>(0),
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(GraphStoreError::Sqlite)
    }

    fn replace(
        &mut self,
        partition: &GraphPartition,
        complete: bool,
        timestamp: WorkflowTimestamp,
        before_commit: impl FnOnce(&Transaction<'_>) -> Result<(), rusqlite::Error>,
    ) -> Result<u64, GraphStoreError> {
        if !complete {
            return Err(GraphStoreError::Incomplete);
        }
        partition.validate()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let generation = replace_partition_in_transaction(&transaction, partition, timestamp)?;
        before_commit(&transaction)?;
        transaction.commit()?;
        Ok(generation)
    }

    pub fn load_partition(
        &self,
        partition_id: PartitionId,
    ) -> Result<Option<GraphPartition>, GraphStoreError> {
        let metadata: Option<(String, String, i64)> = self
            .connection
            .query_row(
                "SELECT project_id, scope, head_generation FROM code_partitions WHERE id = ?1",
                [partition_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((project_id, scope, generation)) = metadata else {
            return Ok(None);
        };
        let mut nodes = std::collections::BTreeMap::new();
        let mut statement = self.connection.prepare(
            "SELECT id, node_json FROM code_nodes
             WHERE partition_id = ?1 AND generation = ?2 ORDER BY id",
        )?;
        let rows = statement.query_map(params![partition_id.to_string(), generation], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (row_id, json) = row?;
            let node = deserialize_node(partition_id, &row_id, &json)?;
            nodes.insert(node.id, node);
        }
        let mut edges = std::collections::BTreeMap::new();
        let mut statement = self.connection.prepare(
            "SELECT id, edge_json FROM code_edges
             WHERE partition_id = ?1 AND generation = ?2 ORDER BY id",
        )?;
        let rows = statement.query_map(params![partition_id.to_string(), generation], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (row_id, json) = row?;
            let edge = deserialize_edge(partition_id, &row_id, &json)?;
            edges.insert(edge.id, edge);
        }
        let mut partition = GraphPartition {
            edges,
            external_nodes: Default::default(),
            id: partition_id,
            nodes,
            project_id: project_id
                .parse()
                .map_err(|_| GraphStoreError::Domain(GraphError::InvalidPartition))?,
            scope,
        };
        for edge in partition.edges.values() {
            if !partition.nodes.contains_key(&edge.source) {
                partition.external_nodes.insert(edge.source);
            }
            if !partition.nodes.contains_key(&edge.target) {
                partition.external_nodes.insert(edge.target);
            }
        }
        partition.validate()?;
        Ok(Some(partition))
    }
}

fn restore_full_v1_compatibility(connection: &mut Connection) -> Result<(), GraphStoreError> {
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id == FULL_V1_APPLICATION_ID {
        return Ok(());
    }
    if application_id != 0 {
        return Err(GraphStoreError::UnsupportedApplicationId(application_id));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let partitions = {
        let mut statement =
            transaction.prepare("SELECT id, project_id, scope FROM code_partitions ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for (stored_partition_id, stored_project_id, scope) in partitions {
        let project_id = stored_project_id
            .parse::<ProjectId>()
            .map_err(|_| GraphStoreError::Domain(GraphError::InvalidPartition))?;
        let partition_id = PartitionId::new(project_id, &scope);
        if partition_id.to_string() != stored_partition_id {
            return Err(GraphStoreError::Domain(GraphError::InvalidPartition));
        }

        let nodes = {
            let mut statement = transaction.prepare(
                "SELECT generation, id, node_json FROM code_nodes
                 WHERE partition_id = ?1 ORDER BY generation, id",
            )?;
            let rows = statement.query_map([&stored_partition_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (generation, row_id, json) in nodes {
            let node = deserialize_node(partition_id, &row_id, &json)?;
            let full_json = serde_json::to_string(&node)?;
            if full_json != json {
                transaction.execute(
                    "UPDATE code_nodes SET node_json = ?1
                     WHERE partition_id = ?2 AND generation = ?3 AND id = ?4",
                    params![full_json, &stored_partition_id, generation, row_id],
                )?;
            }
        }

        let edges = {
            let mut statement = transaction.prepare(
                "SELECT generation, id, edge_json FROM code_edges
                 WHERE partition_id = ?1 ORDER BY generation, id",
            )?;
            let rows = statement.query_map([&stored_partition_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (generation, row_id, json) in edges {
            let edge = deserialize_edge(partition_id, &row_id, &json)?;
            let full_json = serde_json::to_string(&edge)?;
            if full_json != json {
                transaction.execute(
                    "UPDATE code_edges SET edge_json = ?1
                     WHERE partition_id = ?2 AND generation = ?3 AND id = ?4",
                    params![full_json, &stored_partition_id, generation, row_id],
                )?;
            }
        }
    }

    transaction.pragma_update(None, "application_id", FULL_V1_APPLICATION_ID)?;
    transaction.commit()?;
    Ok(())
}

impl PartitionBatch<'_> {
    pub fn replace_partition(&self, partition: &GraphPartition) -> Result<u64, GraphStoreError> {
        partition.validate()?;
        replace_partition_in_transaction(&self.transaction, partition, self.timestamp)
    }

    pub fn replace_manifest_scopes(
        &self,
        project_id: ProjectId,
        scopes: &std::collections::BTreeSet<String>,
        entries: &[ManifestEntry],
    ) -> Result<(), GraphStoreError> {
        replace_manifest_scopes_in_transaction(&self.transaction, project_id, scopes, entries)
    }

    pub fn commit(self) -> Result<(), GraphStoreError> {
        self.transaction.commit().map_err(GraphStoreError::Sqlite)
    }
}

fn replace_partition_in_transaction(
    transaction: &Transaction<'_>,
    partition: &GraphPartition,
    timestamp: WorkflowTimestamp,
) -> Result<u64, GraphStoreError> {
    let current: Option<i64> = transaction
        .query_row(
            "SELECT head_generation FROM code_partitions WHERE id = ?1",
            [partition.id.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    let generation = current
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(GraphStoreError::IntegerRange)?;
    transaction.execute(
        "INSERT INTO code_partitions(id, project_id, scope, head_generation, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           head_generation = excluded.head_generation,
           updated_at = excluded.updated_at",
        params![
            partition.id.to_string(),
            partition.project_id.to_string(),
            &partition.scope,
            generation,
            timestamp.to_string(),
        ],
    )?;
    {
        let mut statement = transaction.prepare(
            "INSERT INTO code_nodes(partition_id, generation, id, node_json)
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        for node in partition.nodes.values() {
            statement.execute(params![
                partition.id.to_string(),
                generation,
                node.id.to_string(),
                serialize_node(node)?,
            ])?;
        }
    }
    {
        let mut statement = transaction.prepare(
            "INSERT INTO code_edges(
                partition_id, generation, id, source_id, target_id, edge_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for edge in partition.edges.values() {
            statement.execute(params![
                partition.id.to_string(),
                generation,
                edge.id.to_string(),
                edge.source.to_string(),
                edge.target.to_string(),
                serialize_edge(edge)?,
            ])?;
        }
    }
    transaction.execute(
        "DELETE FROM code_nodes WHERE partition_id = ?1 AND generation < ?2",
        params![partition.id.to_string(), generation],
    )?;
    transaction.execute(
        "DELETE FROM code_edges WHERE partition_id = ?1 AND generation < ?2",
        params![partition.id.to_string(), generation],
    )?;
    u64::try_from(generation).map_err(|_| GraphStoreError::IntegerRange)
}

fn replace_manifest_scopes_in_transaction(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    scopes: &std::collections::BTreeSet<String>,
    entries: &[ManifestEntry],
) -> Result<(), GraphStoreError> {
    for scope in scopes {
        if scope == "root" {
            transaction.execute(
                "DELETE FROM code_manifest
                 WHERE project_id = ?1 AND instr(relative_path, '/') = 0",
                [project_id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM code_paths_fts
                 WHERE project_id = ?1 AND instr(relative_path, '/') = 0",
                [project_id.to_string()],
            )?;
        } else {
            let prefix = format!("{}/%", escape_like(scope));
            transaction.execute(
                "DELETE FROM code_manifest
                 WHERE project_id = ?1 AND relative_path LIKE ?2 ESCAPE '\\'",
                params![project_id.to_string(), &prefix],
            )?;
            transaction.execute(
                "DELETE FROM code_paths_fts
                 WHERE project_id = ?1 AND relative_path LIKE ?2 ESCAPE '\\'",
                params![project_id.to_string(), &prefix],
            )?;
        }
    }
    {
        let mut statement = transaction.prepare(
            "INSERT INTO code_manifest(
                project_id, relative_path, length, modified_unix_nanos, content_hash, entry_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for entry in entries {
            insert_manifest_entry(&mut statement, project_id, entry)?;
        }
    }
    populate_path_search(transaction, project_id, entries.iter())?;
    Ok(())
}

fn serialize_node(node: &GraphNode) -> Result<String, GraphStoreError> {
    serde_json::to_string(node).map_err(GraphStoreError::Serialization)
}

fn deserialize_node(
    partition_id: PartitionId,
    row_id: &str,
    json: &str,
) -> Result<GraphNode, GraphStoreError> {
    let node = match serde_json::from_str::<GraphNode>(json) {
        Ok(node) => node,
        Err(_) => {
            let stored = serde_json::from_str::<StoredGraphNode>(json)?;
            GraphNode::new(NodeInput {
                confidence: stored.confidence,
                kind: stored.kind,
                name: stored.name,
                partition_id,
                provider: stored.provider,
                qualified_name: stored.qualified_name,
                range: stored.range,
                source_path: stored.source_path,
            })?
        }
    };
    if node.partition_id != partition_id || node.id.to_string() != row_id {
        return Err(GraphStoreError::Domain(GraphError::InvalidPartition));
    }
    Ok(node)
}

fn serialize_edge(edge: &GraphEdge) -> Result<String, GraphStoreError> {
    serde_json::to_string(edge).map_err(GraphStoreError::Serialization)
}

fn deserialize_edge(
    partition_id: PartitionId,
    row_id: &str,
    json: &str,
) -> Result<GraphEdge, GraphStoreError> {
    let edge = match serde_json::from_str::<GraphEdge>(json) {
        Ok(edge) => edge,
        Err(_) => {
            let stored = serde_json::from_str::<StoredGraphEdge>(json)?;
            GraphEdge::new(EdgeInput {
                confidence: stored.confidence,
                kind: stored.kind,
                partition_id,
                provider: stored.provider,
                range: stored.range,
                source: stored.source,
                source_path: stored.source_path,
                target: stored.target,
            })?
        }
    };
    if edge.partition_id != partition_id || edge.id.to_string() != row_id {
        return Err(GraphStoreError::Domain(GraphError::InvalidPartition));
    }
    Ok(edge)
}

fn insert_manifest_entry(
    statement: &mut rusqlite::Statement<'_>,
    project_id: ProjectId,
    entry: &ManifestEntry,
) -> Result<(), GraphStoreError> {
    statement.execute(params![
        project_id.to_string(),
        &entry.relative_path,
        i64::try_from(entry.metadata.length).map_err(|_| GraphStoreError::IntegerRange)?,
        entry
            .metadata
            .modified_unix_nanos
            .map(|value| value.to_string()),
        entry.content_hash.to_string(),
        serde_json::to_string(entry)?,
    ])?;
    Ok(())
}

fn populate_path_search<'a>(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    entries: impl IntoIterator<Item = &'a ManifestEntry>,
) -> Result<(), GraphStoreError> {
    let mut statement = transaction
        .prepare("INSERT INTO code_paths_fts(project_id, relative_path) VALUES (?1, ?2)")?;
    for entry in entries {
        statement.execute(params![project_id.to_string(), &entry.relative_path])?;
    }
    Ok(())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{
        EdgeInput, EdgeKind, FactConfidence, FactProvider, GraphEdge, GraphNode, GraphPartition,
        NodeInput, NodeKind,
    };
    use workflow_core::ProjectId;

    const EXPECTED_FULL_V1_APPLICATION_ID: i64 = 0x4f57_4631;

    fn sample_partition() -> GraphPartition {
        let project = ProjectId::new();
        let partition_id = PartitionId::new(project, "src");
        let first = GraphNode::new(NodeInput {
            confidence: FactConfidence::Extracted,
            kind: NodeKind::File,
            name: "first".to_owned(),
            partition_id,
            provider: FactProvider::Parser("test".to_owned()),
            qualified_name: "first".to_owned(),
            range: None,
            source_path: "src/first.rs".to_owned(),
        })
        .unwrap();
        let second = GraphNode::new(NodeInput {
            confidence: FactConfidence::Extracted,
            kind: NodeKind::Symbol,
            name: "second".to_owned(),
            partition_id,
            provider: FactProvider::Parser("test".to_owned()),
            qualified_name: "first::second".to_owned(),
            range: None,
            source_path: "src/first.rs".to_owned(),
        })
        .unwrap();
        let third = GraphNode::new(NodeInput {
            confidence: FactConfidence::Extracted,
            kind: NodeKind::Symbol,
            name: "third".to_owned(),
            partition_id,
            provider: FactProvider::Parser("test".to_owned()),
            qualified_name: "first::third".to_owned(),
            range: None,
            source_path: "src/first.rs".to_owned(),
        })
        .unwrap();
        let contains = GraphEdge::new(EdgeInput {
            confidence: FactConfidence::Extracted,
            kind: EdgeKind::Contains,
            partition_id,
            provider: FactProvider::Parser("test".to_owned()),
            range: None,
            source: first.id,
            source_path: "src/first.rs".to_owned(),
            target: second.id,
        })
        .unwrap();
        let defines = GraphEdge::new(EdgeInput {
            confidence: FactConfidence::Extracted,
            kind: EdgeKind::Defines,
            partition_id,
            provider: FactProvider::Parser("test".to_owned()),
            range: None,
            source: first.id,
            source_path: "src/first.rs".to_owned(),
            target: third.id,
        })
        .unwrap();
        GraphPartition {
            edges: [(contains.id, contains), (defines.id, defines)]
                .into_iter()
                .collect(),
            external_nodes: Default::default(),
            id: partition_id,
            nodes: [(first.id, first), (second.id, second), (third.id, third)]
                .into_iter()
                .collect(),
            project_id: project,
            scope: "src".to_owned(),
        }
    }

    fn compact_node_json(node: &GraphNode) -> String {
        serde_json::to_string(&StoredGraphNode {
            confidence: node.confidence,
            kind: node.kind,
            name: node.name.clone(),
            provider: node.provider.clone(),
            qualified_name: node.qualified_name.clone(),
            range: node.range,
            source_path: node.source_path.clone(),
        })
        .unwrap()
    }

    fn compact_edge_json(edge: &GraphEdge) -> String {
        serde_json::to_string(&StoredGraphEdge {
            confidence: edge.confidence,
            kind: edge.kind,
            provider: edge.provider.clone(),
            range: edge.range,
            source: edge.source,
            source_path: edge.source_path.clone(),
            target: edge.target,
        })
        .unwrap()
    }

    fn write_compact_rows(connection: &Connection, partition: &GraphPartition) {
        connection.pragma_update(None, "application_id", 0).unwrap();
        for node in partition.nodes.values() {
            connection
                .execute(
                    "UPDATE code_nodes SET node_json = ?1 WHERE id = ?2",
                    params![compact_node_json(node), node.id.to_string()],
                )
                .unwrap();
        }
        for edge in partition.edges.values() {
            connection
                .execute(
                    "UPDATE code_edges SET edge_json = ?1 WHERE id = ?2",
                    params![compact_edge_json(edge), edge.id.to_string()],
                )
                .unwrap();
        }
    }

    fn predecessor_load_partition(
        connection: &Connection,
        partition_id: PartitionId,
    ) -> GraphPartition {
        let (project_id, scope, generation): (String, String, i64) = connection
            .query_row(
                "SELECT project_id, scope, head_generation FROM code_partitions WHERE id = ?1",
                [partition_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let mut nodes = std::collections::BTreeMap::new();
        let mut statement = connection
            .prepare(
                "SELECT node_json FROM code_nodes
                 WHERE partition_id = ?1 AND generation = ?2 ORDER BY id",
            )
            .unwrap();
        let rows = statement
            .query_map(params![partition_id.to_string(), generation], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        for row in rows {
            let node = serde_json::from_str::<GraphNode>(&row.unwrap()).unwrap();
            nodes.insert(node.id, node);
        }
        let mut edges = std::collections::BTreeMap::new();
        let mut statement = connection
            .prepare(
                "SELECT edge_json FROM code_edges
                 WHERE partition_id = ?1 AND generation = ?2 ORDER BY id",
            )
            .unwrap();
        let rows = statement
            .query_map(params![partition_id.to_string(), generation], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        for row in rows {
            let edge = serde_json::from_str::<GraphEdge>(&row.unwrap()).unwrap();
            edges.insert(edge.id, edge);
        }
        let mut partition = GraphPartition {
            edges,
            external_nodes: Default::default(),
            id: partition_id,
            nodes,
            project_id: project_id.parse().unwrap(),
            scope,
        };
        for edge in partition.edges.values() {
            if !partition.nodes.contains_key(&edge.source) {
                partition.external_nodes.insert(edge.source);
            }
            if !partition.nodes.contains_key(&edge.target) {
                partition.external_nodes.insert(edge.target);
            }
        }
        partition.validate().unwrap();
        partition
    }

    #[test]
    fn graph_store_uses_bounded_cache_and_memory_temporaries() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workflow.db");
        drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());

        let store = GraphStore::open(path).unwrap();
        let cache_kib: i64 = store
            .connection
            .pragma_query_value(None, "cache_size", |row| row.get(0))
            .unwrap();
        let temp_store: i64 = store
            .connection
            .pragma_query_value(None, "temp_store", |row| row.get(0))
            .unwrap();

        assert_eq!(cache_kib, -65_536);
        assert_eq!(temp_store, 2);
    }

    #[test]
    fn unknown_storage_application_id_fails_closed() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workflow.db");
        drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "application_id", 0x1234_5678_i64)
            .unwrap();
        drop(connection);

        assert!(matches!(
            GraphStore::open(&path),
            Err(GraphStoreError::UnsupportedApplicationId(0x1234_5678))
        ));
    }

    #[test]
    fn compact_rows_are_atomically_restored_for_the_predecessor_reader() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workflow.db");
        drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());
        let partition = sample_partition();
        let timestamp = WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap();
        let mut store = GraphStore::open(&path).unwrap();
        store
            .replace_partition(&partition, true, timestamp)
            .unwrap();
        assert_eq!(
            predecessor_load_partition(&store.connection, partition.id),
            partition
        );
        write_compact_rows(&store.connection, &partition);
        let legacy_edge = partition.edges.values().next().unwrap();
        store
            .connection
            .execute(
                "UPDATE code_edges SET edge_json = ?1 WHERE id = ?2",
                params![
                    serde_json::to_string(legacy_edge).unwrap(),
                    legacy_edge.id.to_string()
                ],
            )
            .unwrap();
        drop(store);

        drop(GraphStore::open(&path).unwrap());
        let connection = Connection::open(&path).unwrap();
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .unwrap();
        assert_eq!(application_id, EXPECTED_FULL_V1_APPLICATION_ID);
        let full_edges: u32 = connection
            .query_row(
                "SELECT count(*) FROM code_edges WHERE json_type(edge_json, '$.id') = 'text'
                 AND json_type(edge_json, '$.partition_id') = 'text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(full_edges, 2);
        assert_eq!(
            predecessor_load_partition(&connection, partition.id),
            partition
        );
    }

    #[test]
    fn corrupt_row_id_blocks_recovery_and_rolls_back_every_rewrite() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workflow.db");
        drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());
        let partition = sample_partition();
        let timestamp = WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap();
        let mut store = GraphStore::open(&path).unwrap();
        store
            .replace_partition(&partition, true, timestamp)
            .unwrap();
        write_compact_rows(&store.connection, &partition);
        let corrupt = partition.nodes.values().next().unwrap();
        store
            .connection
            .execute(
                "UPDATE code_nodes SET id = ?1 WHERE id = ?2",
                params!["0".repeat(64), corrupt.id.to_string()],
            )
            .unwrap();
        drop(store);

        assert!(GraphStore::open(&path).is_err());
        let connection = Connection::open(&path).unwrap();
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .unwrap();
        let compact_rows: u32 = connection
            .query_row(
                "SELECT count(*) FROM code_nodes WHERE json_type(node_json, '$.id') IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(application_id, 0);
        assert_eq!(compact_rows, 3);
    }

    #[test]
    fn corrupt_partition_identity_blocks_recovery() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workflow.db");
        drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());
        let partition = sample_partition();
        let timestamp = WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap();
        let mut store = GraphStore::open(&path).unwrap();
        store
            .replace_partition(&partition, true, timestamp)
            .unwrap();
        write_compact_rows(&store.connection, &partition);
        let mut corrupt = partition.nodes.values().next().unwrap().clone();
        corrupt.partition_id = PartitionId::new(ProjectId::new(), "src");
        store
            .connection
            .execute(
                "UPDATE code_nodes SET node_json = ?1 WHERE id = ?2",
                params![
                    serde_json::to_string(&corrupt).unwrap(),
                    corrupt.id.to_string()
                ],
            )
            .unwrap();
        drop(store);

        assert!(GraphStore::open(&path).is_err());
        let connection = Connection::open(&path).unwrap();
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .unwrap();
        assert_eq!(application_id, 0);
    }

    #[test]
    fn failed_transaction_keeps_the_prior_generation_readable() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workflow.db");
        drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());
        let project = ProjectId::new();
        let partition = GraphPartition {
            edges: Default::default(),
            external_nodes: Default::default(),
            id: PartitionId::new(project, "src"),
            nodes: Default::default(),
            project_id: project,
            scope: "src".to_owned(),
        };
        let timestamp = WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap();
        let mut store = GraphStore::open(path).unwrap();
        store
            .replace_partition(&partition, true, timestamp)
            .unwrap();
        assert!(
            store
                .replace(&partition, true, timestamp, |transaction| {
                    transaction.execute_batch("INVALID SQL")
                })
                .is_err()
        );
        assert_eq!(store.load_partition(partition.id).unwrap(), Some(partition));
    }

    #[test]
    fn partition_batch_commits_every_generation_together() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("workflow.db");
        drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());
        let project = ProjectId::new();
        let first = GraphPartition {
            edges: Default::default(),
            external_nodes: Default::default(),
            id: PartitionId::new(project, "src/a"),
            nodes: Default::default(),
            project_id: project,
            scope: "src/a".to_owned(),
        };
        let second = GraphPartition {
            id: PartitionId::new(project, "src/b"),
            scope: "src/b".to_owned(),
            ..first.clone()
        };
        let timestamp = WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap();
        let mut store = GraphStore::open(path).unwrap();

        let batch = store.partition_batch(timestamp).unwrap();
        let generations = vec![
            batch.replace_partition(&first).unwrap(),
            batch.replace_partition(&second).unwrap(),
        ];
        batch.commit().unwrap();

        assert_eq!(generations, vec![1, 1]);
        assert_eq!(store.load_partition(first.id).unwrap(), Some(first));
        assert_eq!(store.load_partition(second.id).unwrap(), Some(second));
    }
}
