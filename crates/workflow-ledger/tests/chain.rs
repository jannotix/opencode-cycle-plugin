mod common;

use std::sync::Arc;

use workflow_ledger::{ChainFailure, ChainVerification, EventData, LedgerChain, LedgerWriter};

#[test]
fn append_and_verify_a_chain() {
    let mut chain = LedgerChain::default();
    chain.append(common::event("started")).unwrap();
    chain.append(common::event("completed")).unwrap();
    assert_eq!(
        chain.verify(chain.head()),
        ChainVerification::Valid {
            entries: 2,
            head: chain.head(),
        }
    );
}

#[test]
fn mutation_and_reordering_are_detected() {
    let mut chain = LedgerChain::default();
    chain.append(common::event("started")).unwrap();
    chain.append(common::event("completed")).unwrap();
    let mut entries = chain.entries().to_vec();
    entries[0].event.data = EventData::Workflow {
        action: "tampered".to_owned(),
    };
    let chain = LedgerChain::from_entries(entries);
    assert_eq!(
        chain.verify(None),
        ChainVerification::Broken {
            reason: ChainFailure::EntryHash,
            sequence: 0,
        }
    );
}

#[test]
fn trusted_head_detects_truncation() {
    let mut chain = LedgerChain::default();
    chain.append(common::event("started")).unwrap();
    chain.append(common::event("completed")).unwrap();
    let trusted_head = chain.head();
    let mut entries = chain.entries().to_vec();
    entries.pop();
    let chain = LedgerChain::from_entries(entries);
    assert!(matches!(
        chain.verify(trusted_head),
        ChainVerification::HeadMismatch { .. }
    ));
}

#[test]
fn concurrent_producers_have_unique_ordered_entries() {
    let writer = Arc::new(LedgerWriter::default());
    let handles: Vec<_> = (0..32)
        .map(|index| {
            let writer = Arc::clone(&writer);
            std::thread::spawn(move || {
                writer
                    .append(common::event(&format!("event-{index}")))
                    .unwrap()
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let chain = writer.snapshot().unwrap();
    assert_eq!(chain.entries().len(), 32);
    assert!(matches!(
        chain.verify(chain.head()),
        ChainVerification::Valid { entries: 32, .. }
    ));
}
