use std::{collections::BTreeSet, num::NonZeroUsize, path::PathBuf};

use tempfile::TempDir;
use workflow_core::{EventId, MemoryId, ProjectId, WorkflowTimestamp};
use workflow_ledger::{Actor, EventData, LedgerEvent, Redactor};
use workflow_memory::{ConfidenceClass, MemoryEntry, MemoryKind, MemoryState, Provenance};
use workflow_store::Store;

pub fn database() -> (TempDir, PathBuf, ProjectId, EventId) {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("workflow.db");
    let project = ProjectId::new();
    let event = LedgerEvent::new(
        Actor {
            id: "test".to_owned(),
            model: None,
            role: None,
            session_id: None,
        },
        None,
        EventData::Workflow {
            action: "completed".to_owned(),
        },
        [],
        [],
        Default::default(),
        project,
        None,
        WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap(),
        None,
        &Redactor::default(),
    )
    .unwrap();
    let event_id = event.event_id;
    let mut store = Store::open(&path, NonZeroUsize::new(2).unwrap()).unwrap();
    store.append_ledger_event(event).unwrap();
    drop(store);
    (temporary, path, project, event_id)
}

pub fn entry(project_id: ProjectId, event_id: EventId, title: &str, summary: &str) -> MemoryEntry {
    MemoryEntry {
        actor: "architect".to_owned(),
        confidence: ConfidenceClass::UserAsserted,
        created_at: WorkflowTimestamp::parse("2026-08-12T12:01:00Z").unwrap(),
        detail: format!("Detailed project knowledge for {summary}"),
        id: MemoryId::new(),
        kind: MemoryKind::ArchitectureDecision,
        project_id,
        provenance: Provenance {
            candidate_id: None,
            evidence_ids: BTreeSet::new(),
            revision: Some("abc123".to_owned()),
            source_event_ids: BTreeSet::from([event_id]),
        },
        scope: BTreeSet::from(["backend/api".to_owned()]),
        state: MemoryState::Current,
        summary: summary.to_owned(),
        superseded_by: None,
        title: title.to_owned(),
    }
}
