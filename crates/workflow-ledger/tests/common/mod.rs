use std::collections::BTreeMap;

use workflow_core::{ProjectId, WorkflowId, WorkflowTimestamp};
use workflow_ledger::{Actor, EventData, LedgerEvent, Redactor};

pub fn event(action: &str) -> LedgerEvent {
    LedgerEvent::new(
        Actor {
            id: "workflowd".to_owned(),
            model: None,
            role: None,
            session_id: None,
        },
        None,
        EventData::Workflow {
            action: action.to_owned(),
        },
        [],
        ["src/lib.rs".to_owned()],
        BTreeMap::new(),
        ProjectId::new(),
        None,
        WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap(),
        Some(WorkflowId::new()),
        &Redactor::default(),
    )
    .unwrap()
}
