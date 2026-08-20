use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::graph::{FactConfidence, FactProvider, GraphPartition, NodeId, NodeKind, SourceRange};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextLevel {
    Inventory,
    Subgraph,
    Symbol,
    Source,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContextBudget {
    pub max_bytes: usize,
    pub max_items: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ContextItem {
    pub confidence: FactConfidence,
    pub id: NodeId,
    pub kind: NodeKind,
    pub level: ContextLevel,
    pub name: String,
    pub provider: FactProvider,
    pub range: Option<SourceRange>,
    pub source: Option<String>,
    pub source_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ContextBundle {
    pub bytes: usize,
    pub items: Vec<ContextItem>,
    pub level: ContextLevel,
    pub truncated: bool,
}

#[must_use]
pub fn context_bundle(
    partition: &GraphPartition,
    selected: &BTreeSet<NodeId>,
    level: ContextLevel,
    source: &BTreeMap<String, String>,
    budget: ContextBudget,
) -> ContextBundle {
    let mut candidates: Vec<_> = partition
        .nodes
        .values()
        .filter(|node| match level {
            ContextLevel::Inventory => node.kind == NodeKind::File,
            ContextLevel::Subgraph => selected.contains(&node.id),
            ContextLevel::Symbol | ContextLevel::Source => {
                selected.contains(&node.id) && node.kind != NodeKind::File
            }
        })
        .map(|node| ContextItem {
            confidence: node.confidence,
            id: node.id,
            kind: node.kind,
            level,
            name: node.name.clone(),
            provider: node.provider.clone(),
            range: node.range,
            source: (level == ContextLevel::Source)
                .then(|| source.get(&node.source_path).cloned())
                .flatten(),
            source_path: node.source_path.clone(),
        })
        .collect();
    candidates.sort_by_key(|item| item.id);
    let candidate_count = candidates.len();
    let mut bytes = 0_usize;
    let items: Vec<_> = candidates
        .into_iter()
        .take(budget.max_items)
        .take_while(|item| {
            let size = serde_json::to_vec(item).map_or(usize::MAX, |value| value.len());
            if bytes.saturating_add(size) > budget.max_bytes {
                false
            } else {
                bytes += size;
                true
            }
        })
        .collect();
    ContextBundle {
        bytes,
        truncated: items.len() < candidate_count,
        items,
        level,
    }
}
