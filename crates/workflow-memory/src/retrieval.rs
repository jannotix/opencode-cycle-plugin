use std::collections::BTreeSet;

use serde::Serialize;
use workflow_core::MemoryId;

use crate::{ConfidenceClass, MemoryEntry, MemoryKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetrievalBudget {
    pub max_bytes: usize,
    pub max_items: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CompactMemory {
    pub confidence: ConfidenceClass,
    pub evidence_count: usize,
    pub id: MemoryId,
    pub kind: MemoryKind,
    pub scope: BTreeSet<String>,
    pub source_count: usize,
    pub summary: String,
    pub title: String,
}

#[must_use]
pub fn compact(entries: &[MemoryEntry], budget: RetrievalBudget) -> Vec<CompactMemory> {
    let mut bytes: usize = 0;
    entries
        .iter()
        .take(budget.max_items)
        .map(|entry| CompactMemory {
            confidence: entry.confidence,
            evidence_count: entry.provenance.evidence_ids.len(),
            id: entry.id,
            kind: entry.kind,
            scope: entry.scope.clone(),
            source_count: entry.provenance.source_event_ids.len(),
            summary: entry.summary.clone(),
            title: entry.title.clone(),
        })
        .take_while(|entry| {
            let size = serde_json::to_vec(entry).map_or(usize::MAX, |value| value.len());
            if bytes.saturating_add(size) > budget.max_bytes {
                false
            } else {
                bytes += size;
                true
            }
        })
        .collect()
}

#[must_use]
pub fn selected_details(
    entries: &[MemoryEntry],
    selected: &BTreeSet<MemoryId>,
    max_bytes: usize,
) -> Vec<MemoryEntry> {
    let mut bytes: usize = 0;
    entries
        .iter()
        .filter(|entry| selected.contains(&entry.id))
        .take_while(|entry| {
            let size = serde_json::to_vec(entry).map_or(usize::MAX, |value| value.len());
            if bytes.saturating_add(size) > max_bytes {
                false
            } else {
                bytes += size;
                true
            }
        })
        .cloned()
        .collect()
}
