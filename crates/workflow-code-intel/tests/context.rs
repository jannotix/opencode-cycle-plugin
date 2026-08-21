mod common;

use std::collections::{BTreeMap, BTreeSet};

use workflow_code_intel::{ContextBudget, ContextLevel, context_bundle};
use workflow_core::ProjectId;

#[test]
fn context_progresses_from_inventory_to_selected_source() {
    let partition = common::partition(ProjectId::new(), "src", &["run", "verify"]);
    let run = partition
        .nodes
        .values()
        .find(|node| node.name == "run")
        .unwrap();
    let budget = ContextBudget {
        max_bytes: 16 * 1024,
        max_items: 10,
    };
    let inventory = context_bundle(
        &partition,
        &BTreeSet::new(),
        ContextLevel::Inventory,
        &BTreeMap::new(),
        budget,
    );
    assert_eq!(inventory.items.len(), 1);
    assert!(inventory.items[0].source.is_none());

    let source = context_bundle(
        &partition,
        &BTreeSet::from([run.id]),
        ContextLevel::Source,
        &BTreeMap::from([("src/lib.rs".to_owned(), "fn run() {}".to_owned())]),
        budget,
    );
    assert_eq!(source.items.len(), 1);
    assert_eq!(source.items[0].source.as_deref(), Some("fn run() {}"));
    assert_eq!(source.items[0].provider, run.provider);
}

#[test]
fn context_budget_is_strict_and_reports_truncation() {
    let partition = common::partition(ProjectId::new(), "src", &["run", "verify"]);
    let selected = partition.nodes.keys().copied().collect();
    let result = context_bundle(
        &partition,
        &selected,
        ContextLevel::Subgraph,
        &BTreeMap::new(),
        ContextBudget {
            max_bytes: 1,
            max_items: 1,
        },
    );
    assert!(result.items.is_empty());
    assert!(result.truncated);
    assert_eq!(result.bytes, 0);
}
