//! What a change reaches, so the layer rules see more than the files it edited.
//!
//! N4 taught the rules to read the paths a candidate actually changed instead of only the scopes
//! the architect declared. That still under-states the blast radius: editing a loader that
//! `src/auth/session.ts` imports is a change to authentication, and nothing in the changed set
//! says so. This module answers the missing half — which indexed files reach the changed ones —
//! by walking incoming edges in the project graph.
//!
//! Two properties hold deliberately:
//!
//! - **Promote-only.** Reached paths are unioned into the set the rules match. Adding paths can
//!   insert a gate and can never remove one, so a wrong answer here costs proof, not safety.
//! - **Fail-soft, never fail-open-silently.** When reach cannot be computed — the project was
//!   never indexed, the index does not know a changed file, the store cannot be read — the result
//!   carries a named [`ReachNote::Unresolved`] rather than an empty set pretending the change
//!   reaches nothing. The caller records that note as evidence.

use std::collections::{BTreeMap, BTreeSet};

use workflow_code_intel::{
    TraversalDirection,
    graph::{GraphNode, GraphPartition, GraphStore, NodeId, PartitionId},
    impact,
    languages::adapter_for,
};
use workflow_core::ProjectId;

/// Incoming depth. Two hops reaches a file's importers and their importers, which is where the
/// interesting blast radius lives; beyond that most projects reach their own entrypoint and the
/// answer stops discriminating.
const MAX_DEPTH: usize = 2;
/// Floor for the node ceiling, so a small project still gets a useful answer.
const MIN_NODE_CEILING: usize = 200;
/// Share of the indexed graph a single traversal may visit before it is called high-fan-in.
const NODE_CEILING_SHARE: usize = 10;
/// How many hub paths a high-fan-in note names.
const HUB_REPORT_LIMIT: usize = 10;
/// Upper bound on partitions merged for one traversal.
const MAX_PARTITIONS: usize = 4_096;

/// Why a reach answer is advisory rather than exact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReachNote {
    /// The traversal hit its node ceiling. The named paths are the changed files with the most
    /// direct consumers — the reason the answer is wide. No gate is inserted from a truncated
    /// traversal, because a truncated set is not evidence of what the change reaches.
    HighFanIn(Vec<String>),
    /// Reach was computed exactly, over the stated number of reached files.
    Resolved(usize),
    /// Reach could not be computed, for the stated reason.
    Unresolved(String),
}

/// The files a change reaches, and whether that answer is exact.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Reach {
    pub note: Option<ReachNote>,
    /// Indexed paths that reach the changed set, excluding the changed set itself.
    pub reached: Vec<String>,
}

impl Reach {
    /// The answer for a change that needs no traversal: nothing modelled was touched.
    #[must_use]
    pub fn none() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn unresolved(reason: impl Into<String>) -> Self {
        Self {
            note: Some(ReachNote::Unresolved(reason.into())),
            reached: Vec::new(),
        }
    }
}

/// Compute what `changed` reaches in the project graph.
///
/// Never returns an error: a store that cannot be read is an unresolved reach, not a failed
/// verification plan. Refusing to plan because the graph is unavailable would make an unindexed
/// project unable to run a cycle at all, which is a larger regression than an advisory note.
#[must_use]
pub fn compute(store: &GraphStore, project_id: ProjectId, changed: &[String]) -> Reach {
    let modelled: BTreeSet<String> = changed
        .iter()
        .map(|path| normalize(path))
        .filter(|path| adapter_for(std::path::Path::new(path)).is_some())
        .collect();
    if modelled.is_empty() {
        // Documentation, images, lockfiles: outside the model, and not a gap in it.
        return Reach::none();
    }
    let Some(merged) = merge_partitions(store, project_id) else {
        return Reach::unresolved(
            "the project graph could not be read, so what this change reaches is unknown",
        );
    };
    if merged.nodes.is_empty() {
        return Reach::unresolved(
            "the project has never been indexed, so what this change reaches is unknown; \
             run the index command",
        );
    }
    let indexed: BTreeSet<&str> = merged
        .nodes
        .values()
        .map(|node| node.source_path.as_str())
        .collect();
    let missing: Vec<&str> = modelled
        .iter()
        .map(String::as_str)
        .filter(|path| !indexed.contains(path))
        .collect();
    if !missing.is_empty() {
        return Reach::unresolved(format!(
            "the index does not contain {}, so what this change reaches is unknown; \
             re-run the index command",
            name_list(&missing)
        ));
    }
    let roots: BTreeSet<NodeId> = merged
        .nodes
        .values()
        .filter(|node| modelled.contains(&node.source_path))
        .map(|node| node.id)
        .collect();
    if roots.is_empty() {
        return Reach::unresolved(
            "no indexed symbol belongs to the changed files, so what this change reaches is \
             unknown; re-run the index command",
        );
    }
    let ceiling = (merged.nodes.len() / NODE_CEILING_SHARE).max(MIN_NODE_CEILING);
    let traversal = impact(
        &merged,
        &roots,
        TraversalDirection::Incoming,
        MAX_DEPTH,
        ceiling,
    );
    if traversal.truncated {
        return Reach {
            note: Some(ReachNote::HighFanIn(hubs(&merged, &modelled))),
            reached: Vec::new(),
        };
    }
    let reached = traversal
        .nodes
        .iter()
        .filter_map(|id| merged.nodes.get(id))
        .map(|node| node.source_path.clone())
        .filter(|path| !modelled.contains(path))
        .collect::<BTreeSet<_>>();
    let reached: Vec<String> = reached.into_iter().collect();
    Reach {
        note: Some(ReachNote::Resolved(reached.len())),
        reached,
    }
}

/// Fold every partition of the project into one traversable graph.
///
/// Partitions are per directory scope while edges cross them freely — an importer in `src/app`
/// points at a node in `src/lib`, held as an `external_node` on its own side. Traversing one
/// partition at a time would therefore stop at the first directory boundary and report a reach of
/// almost nothing, which is precisely the wrong direction for a promote-only rule.
fn merge_partitions(store: &GraphStore, project_id: ProjectId) -> Option<GraphPartition> {
    let scopes = store.project_scopes(project_id, MAX_PARTITIONS).ok()?;
    let mut nodes = BTreeMap::new();
    let mut edges = BTreeMap::new();
    for scope in &scopes {
        let Ok(Some(partition)) = store.load_partition(PartitionId::new(project_id, scope)) else {
            continue;
        };
        nodes.extend(partition.nodes);
        edges.extend(partition.edges);
    }
    // An edge whose endpoint was external to every partition we merged has no node to traverse to.
    // Dropping those keeps the traversal honest rather than walking into a node we cannot name.
    edges.retain(|_, edge| nodes.contains_key(&edge.source) && nodes.contains_key(&edge.target));
    let id = PartitionId::new(project_id, "");
    Some(GraphPartition {
        edges,
        external_nodes: BTreeSet::new(),
        id,
        nodes,
        project_id,
        scope: String::new(),
    })
}

/// The changed paths with the most direct consumers, which is why a traversal went wide.
fn hubs(partition: &GraphPartition, modelled: &BTreeSet<String>) -> Vec<String> {
    let mut consumers: BTreeMap<&str, usize> = BTreeMap::new();
    let by_id: BTreeMap<NodeId, &GraphNode> = partition
        .nodes
        .values()
        .map(|node| (node.id, node))
        .collect();
    for edge in partition.edges.values() {
        let Some(target) = by_id.get(&edge.target) else {
            continue;
        };
        if modelled.contains(&target.source_path) {
            *consumers.entry(target.source_path.as_str()).or_default() += 1;
        }
    }
    let mut ranked: Vec<_> = consumers.into_iter().collect();
    // Most consumers first; ties broken by path so the note is deterministic.
    ranked.sort_by(|(left_path, left), (right_path, right)| {
        right.cmp(left).then_with(|| left_path.cmp(right_path))
    });
    ranked
        .into_iter()
        .take(HUB_REPORT_LIMIT)
        .map(|(path, _)| path.to_owned())
        .collect()
}

fn normalize(path: &str) -> String {
    path.replace('\\', "/")
}

fn name_list(paths: &[&str]) -> String {
    const NAMED: usize = 5;
    let named = paths
        .iter()
        .take(NAMED)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    match paths.len().saturating_sub(NAMED) {
        0 => named,
        rest => format!("{named} and {rest} more"),
    }
}
