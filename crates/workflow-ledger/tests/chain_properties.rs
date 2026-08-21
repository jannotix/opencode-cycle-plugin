mod common;

use workflow_ledger::{ChainVerification, LedgerChain};

#[test]
fn every_single_entry_mutation_is_detected() {
    let mut original = LedgerChain::default();
    for index in 0..64 {
        original
            .append(common::event(&format!("event-{index}")))
            .unwrap();
    }
    for index in 0..original.entries().len() {
        let mut entries = original.entries().to_vec();
        entries[index]
            .event
            .metadata
            .insert("mutation".to_owned(), format!("{index}"));
        assert!(matches!(
            LedgerChain::from_entries(entries).verify(original.head()),
            ChainVerification::Broken { .. }
        ));
    }
}

#[test]
fn insertion_and_deletion_are_detected() {
    let mut original = LedgerChain::default();
    for index in 0..8 {
        original
            .append(common::event(&format!("event-{index}")))
            .unwrap();
    }
    let mut inserted = original.entries().to_vec();
    inserted.insert(3, inserted[2].clone());
    assert!(matches!(
        LedgerChain::from_entries(inserted).verify(original.head()),
        ChainVerification::Broken { .. }
    ));

    let mut deleted = original.entries().to_vec();
    deleted.remove(3);
    assert!(matches!(
        LedgerChain::from_entries(deleted).verify(original.head()),
        ChainVerification::Broken { .. }
    ));
}
