mod common;

use std::collections::BTreeMap;

use workflow_ledger::{Actor, EventData, LedgerEvent, Redactor};

#[test]
fn canonical_encoding_is_stable() {
    let event = common::event("started");
    assert_eq!(
        event.canonical_bytes().unwrap(),
        event.canonical_bytes().unwrap()
    );
    assert_eq!(
        serde_json::from_slice::<LedgerEvent>(&event.canonical_bytes().unwrap()).unwrap(),
        event
    );
}

#[test]
fn invalid_events_are_rejected_before_encoding() {
    let mut event = common::event("started");
    event.actor = Actor {
        id: " ".to_owned(),
        model: None,
        role: None,
        session_id: None,
    };
    assert!(
        LedgerEvent::new(
            event.actor,
            None,
            EventData::Workflow {
                action: "started".to_owned(),
            },
            [],
            ["../outside".to_owned()],
            BTreeMap::new(),
            event.project_id,
            None,
            event.timestamp,
            event.workflow_id,
            &Redactor::default(),
        )
        .is_err()
    );
}
