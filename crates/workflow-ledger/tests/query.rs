mod common;

use workflow_ledger::{HistoryExport, HistoryFilter, LedgerChain, query};

#[test]
fn history_filters_and_paginates_without_skipping_matches() {
    let mut chain = LedgerChain::default();
    let first = chain.append(common::event("first")).unwrap();
    let second = chain.append(common::event("second")).unwrap();
    chain.append(common::event("third")).unwrap();

    let filter = HistoryFilter {
        actor: Some("workflowd".to_owned()),
        project_id: Some(second.event.project_id),
        ..HistoryFilter::default()
    };
    let page = query(&chain, &filter, None, 1);
    assert_eq!(page.entries, vec![second]);
    assert_eq!(page.next_sequence, None);

    let all = query(&chain, &HistoryFilter::default(), Some(first.sequence), 1);
    assert_eq!(all.entries[0].sequence, 1);
    assert_eq!(all.next_sequence, Some(1));
}

#[test]
fn exports_contain_public_verification_material_but_no_private_key() {
    let chain = LedgerChain::default();
    let encoded = serde_json::to_string(&HistoryExport::new(&chain, vec![])).unwrap();
    assert_eq!(
        encoded,
        r#"{"checkpoints":[],"entries":[],"format_version":1}"#
    );
    assert!(!encoded.contains("private"));
    assert!(!encoded.contains("seed"));
}
