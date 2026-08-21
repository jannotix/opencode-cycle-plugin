mod common;

use std::collections::BTreeSet;

use workflow_memory::{RetrievalBudget, compact, selected_details};

#[test]
fn compact_retrieval_obeys_item_and_byte_budgets() {
    let (_temporary, _path, project, event) = common::database();
    let entries = vec![
        common::entry(project, event, "First", "First summary"),
        common::entry(project, event, "Second", "Second summary"),
    ];
    let first_size = serde_json::to_vec(
        &compact(
            &entries[..1],
            RetrievalBudget {
                max_bytes: usize::MAX,
                max_items: 1,
            },
        )[0],
    )
    .unwrap()
    .len();
    let result = compact(
        &entries,
        RetrievalBudget {
            max_bytes: first_size,
            max_items: 2,
        },
    );
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].source_count, 1);
    assert!(!result[0].summary.contains("Detailed project knowledge"));
}

#[test]
fn full_details_require_explicit_selected_identifiers() {
    let (_temporary, _path, project, event) = common::database();
    let entries = vec![
        common::entry(project, event, "First", "First summary"),
        common::entry(project, event, "Second", "Second summary"),
    ];
    let result = selected_details(&entries, &BTreeSet::from([entries[1].id]), usize::MAX);
    assert_eq!(result, vec![entries[1].clone()]);
    assert_eq!(result[0].provenance.source_event_ids.len(), 1);
}
