use std::{collections::BTreeMap, time::Duration};

use serde::{Deserialize, Serialize};
use tree_sitter::{Language, Node};
use workflow_core::ProjectId;

use crate::{
    graph::{
        EdgeInput, EdgeKind, FactConfidence, FactProvider, GraphEdge, GraphNode, GraphPartition,
        NodeInput, NodeKind, PartitionId, SourceRange,
    },
    parser::{ParseError, ParseLimits, ParserRuntime},
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LanguageId {
    Bash,
    C,
    CSharp,
    Cpp,
    Css,
    Dart,
    Go,
    Html,
    Java,
    Json,
    Kotlin,
    Php,
    PowerShell,
    Python,
    Ruby,
    Rust,
    Sql,
    Swift,
    Toml,
    Tsx,
    TypeScript,
    Xml,
    Yaml,
}

impl LanguageId {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::C => "c",
            Self::CSharp => "csharp",
            Self::Cpp => "cpp",
            Self::Css => "css",
            Self::Dart => "dart",
            Self::Go => "go",
            Self::Html => "html",
            Self::Java => "java",
            Self::Json => "json",
            Self::Kotlin => "kotlin",
            Self::Php => "php",
            Self::PowerShell => "powershell",
            Self::Python => "python",
            Self::Ruby => "ruby",
            Self::Rust => "rust",
            Self::Sql => "sql",
            Self::Swift => "swift",
            Self::Toml => "toml",
            Self::Tsx => "tsx",
            Self::TypeScript => "typescript",
            Self::Xml => "xml",
            Self::Yaml => "yaml",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterCapabilities {
    pub calls: bool,
    pub configuration: bool,
    pub dependencies: bool,
    pub inheritance: bool,
    pub routes: bool,
    pub schemas: bool,
    pub symbols: bool,
}

#[derive(Clone)]
pub struct LanguageAdapter {
    pub capabilities: AdapterCapabilities,
    pub call_kinds: &'static [&'static str],
    pub configuration_kinds: &'static [&'static str],
    pub dependency_kinds: &'static [&'static str],
    pub id: LanguageId,
    pub inheritance_kinds: &'static [&'static str],
    pub language: fn() -> Language,
    pub route_kinds: &'static [&'static str],
    pub schema_kinds: &'static [&'static str],
    pub symbol_kinds: &'static [&'static str],
}

pub struct Extraction {
    pub capabilities: AdapterCapabilities,
    pub has_errors: bool,
    pub language: LanguageId,
    pub partition: GraphPartition,
}

pub fn extract(
    adapter: &LanguageAdapter,
    project_id: ProjectId,
    scope: &str,
    source_path: &str,
    source: &[u8],
) -> Result<Extraction, ParseError> {
    let runtime = ParserRuntime::new(ParseLimits {
        max_bytes: 4 * 1024 * 1024,
        max_duration: Duration::from_secs(5),
    });
    let tree = runtime.parse(&(adapter.language)(), source, None)?;
    let partition_id = PartitionId::new(project_id, scope);
    let provider = FactProvider::Parser(adapter.id.name().to_owned());
    let file = GraphNode::new(NodeInput {
        confidence: FactConfidence::Extracted,
        kind: NodeKind::File,
        name: source_path
            .rsplit('/')
            .next()
            .unwrap_or(source_path)
            .to_owned(),
        partition_id,
        provider: provider.clone(),
        qualified_name: source_path.to_owned(),
        range: None,
        source_path: source_path.to_owned(),
    })
    .map_err(|_| ParseError::Failed)?;
    let mut partition = GraphPartition {
        edges: BTreeMap::new(),
        external_nodes: Default::default(),
        id: partition_id,
        nodes: BTreeMap::from([(file.id, file.clone())]),
        project_id,
        scope: scope.to_owned(),
    };
    let mut cursor = tree.tree.walk();
    let mut stack = vec![tree.tree.root_node()];
    while let Some(node) = stack.pop() {
        extract_node(
            adapter,
            source,
            source_path,
            &provider,
            &file,
            node,
            &mut partition,
        )
        .map_err(|_| ParseError::Failed)?;
        cursor.reset(node);
        if cursor.goto_first_child() {
            loop {
                stack.push(cursor.node());
                if !cursor.goto_next_sibling() {
                    break;
                }
            }
        }
    }
    Ok(Extraction {
        capabilities: adapter.capabilities,
        has_errors: tree.has_error,
        language: adapter.id,
        partition,
    })
}

fn extract_node(
    adapter: &LanguageAdapter,
    source: &[u8],
    source_path: &str,
    provider: &FactProvider,
    file: &GraphNode,
    node: Node<'_>,
    partition: &mut GraphPartition,
) -> Result<(), crate::graph::GraphError> {
    let kind = node.kind();
    let name = node_name(node, source);
    if name.is_empty() {
        return Ok(());
    }
    let mut facts = Vec::with_capacity(7);
    push_fact(
        &mut facts,
        adapter.symbol_kinds.contains(&kind),
        NodeKind::Symbol,
        EdgeKind::Defines,
    );
    push_fact(
        &mut facts,
        adapter.dependency_kinds.contains(&kind),
        NodeKind::Module,
        EdgeKind::Imports,
    );
    push_fact(
        &mut facts,
        adapter.call_kinds.contains(&kind),
        NodeKind::Symbol,
        EdgeKind::Calls,
    );
    push_fact(
        &mut facts,
        adapter.inheritance_kinds.contains(&kind),
        NodeKind::Symbol,
        EdgeKind::Inherits,
    );
    push_fact(
        &mut facts,
        adapter.route_kinds.contains(&kind) && is_route_candidate(&name),
        NodeKind::Route,
        EdgeKind::RoutesTo,
    );
    push_fact(
        &mut facts,
        adapter.configuration_kinds.contains(&kind),
        NodeKind::Configuration,
        EdgeKind::Configures,
    );
    push_fact(
        &mut facts,
        adapter.schema_kinds.contains(&kind),
        NodeKind::Schema,
        EdgeKind::DependsOn,
    );
    for (node_kind, edge_kind) in facts {
        insert_fact(
            adapter,
            source_path,
            provider,
            file,
            node,
            partition,
            &name,
            node_kind,
            edge_kind,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_fact(
    adapter: &LanguageAdapter,
    source_path: &str,
    provider: &FactProvider,
    file: &GraphNode,
    node: Node<'_>,
    partition: &mut GraphPartition,
    name: &str,
    node_kind: NodeKind,
    edge_kind: EdgeKind,
) -> Result<(), crate::graph::GraphError> {
    let target = GraphNode::new(NodeInput {
        confidence: if matches!(edge_kind, EdgeKind::Calls | EdgeKind::Inherits) {
            FactConfidence::Inferred
        } else {
            FactConfidence::Extracted
        },
        kind: node_kind,
        name: name.to_owned(),
        partition_id: partition.id,
        provider: provider.clone(),
        qualified_name: format!(
            "{}::{source_path}::{node_kind:?}::{name}",
            adapter.id.name()
        ),
        range: Some(range(node)),
        source_path: source_path.to_owned(),
    })?;
    let edge = GraphEdge::new(EdgeInput {
        confidence: target.confidence,
        kind: edge_kind,
        partition_id: partition.id,
        provider: provider.clone(),
        range: target.range,
        source: file.id,
        source_path: source_path.to_owned(),
        target: target.id,
    })?;
    partition.nodes.entry(target.id).or_insert(target);
    partition.edges.entry(edge.id).or_insert(edge);
    Ok(())
}

fn push_fact(
    facts: &mut Vec<(NodeKind, EdgeKind)>,
    enabled: bool,
    node_kind: NodeKind,
    edge_kind: EdgeKind,
) {
    if enabled {
        facts.push((node_kind, edge_kind));
    }
}

fn is_route_candidate(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    [
        ".delete(",
        ".delete",
        ".get(",
        ".get",
        ".head(",
        ".head",
        ".options(",
        ".options",
        ".patch(",
        ".patch",
        ".post(",
        ".post",
        ".put(",
        ".put",
        "@delete",
        "@get",
        "@patch",
        "@post",
        "@put",
        "@route",
        "[httpdelete",
        "[httpget",
        "[httppatch",
        "[httppost",
        "[httpput",
        "route(",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn node_name(node: Node<'_>, source: &[u8]) -> String {
    let named = [
        "name", "function", "type", "path", "source", "module", "table", "object", "tag_name",
        "selector",
    ]
    .into_iter()
    .find_map(|field| node.child_by_field_name(field));
    let node = named.or_else(|| node.named_child(0)).unwrap_or(node);
    node.utf8_text(source)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(256)
        .collect()
}

fn range(node: Node<'_>) -> SourceRange {
    let start = node.start_position();
    let end = node.end_position();
    SourceRange {
        end_byte: u64::try_from(node.end_byte()).unwrap_or(u64::MAX),
        end_column: u32::try_from(end.column).unwrap_or(u32::MAX),
        end_line: u32::try_from(end.row).unwrap_or(u32::MAX),
        start_byte: u64::try_from(node.start_byte()).unwrap_or(u64::MAX),
        start_column: u32::try_from(start.column).unwrap_or(u32::MAX),
        start_line: u32::try_from(start.row).unwrap_or(u32::MAX),
    }
}

pub(crate) const FULL: AdapterCapabilities = AdapterCapabilities {
    calls: true,
    configuration: true,
    dependencies: true,
    inheritance: true,
    routes: true,
    schemas: true,
    symbols: true,
};

pub(crate) const STRUCTURED_DATA: AdapterCapabilities = AdapterCapabilities {
    calls: false,
    configuration: true,
    dependencies: false,
    inheritance: false,
    routes: false,
    schemas: false,
    symbols: false,
};

pub(crate) const SHELL: AdapterCapabilities = AdapterCapabilities {
    calls: true,
    configuration: true,
    dependencies: true,
    inheritance: false,
    routes: false,
    schemas: false,
    symbols: true,
};

pub(crate) const SQL: AdapterCapabilities = AdapterCapabilities {
    calls: true,
    configuration: false,
    dependencies: true,
    inheritance: false,
    routes: false,
    schemas: true,
    symbols: true,
};

pub(crate) const WEB: AdapterCapabilities = AdapterCapabilities {
    calls: false,
    configuration: true,
    dependencies: true,
    inheritance: false,
    routes: false,
    schemas: false,
    symbols: true,
};
