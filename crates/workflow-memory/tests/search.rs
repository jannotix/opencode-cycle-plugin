mod common;

use workflow_core::{EventId, ProjectId, WorkflowTimestamp};
use workflow_memory::{ConfidenceClass, MemorySearch, MemoryState, MemoryStore};

fn search(project_id: ProjectId, text: &str) -> MemorySearch {
    MemorySearch {
        confidence: None,
        from: None,
        include_inactive: false,
        limit: 100,
        project_id,
        scope: None,
        text: text.to_owned(),
        to: None,
    }
}

#[test]
fn fts_search_handles_unicode_code_tokens_and_project_scope() {
    let (_temporary, path, project, event) = common::database();
    let mut store = MemoryStore::open(path).unwrap();
    let first = common::entry(
        project,
        event,
        "HTTP_server::route",
        "Il caffè endpoint uses stable routing",
    );
    store.insert(&first).unwrap();
    assert_eq!(
        store
            .search(&search(project, "HTTP_server::route"))
            .unwrap(),
        vec![first.clone()]
    );
    assert_eq!(
        store.search(&search(project, "caffè")).unwrap(),
        vec![first]
    );
    assert!(
        store
            .search(&search(ProjectId::new(), "caffè"))
            .unwrap()
            .is_empty()
    );
    assert!(store.search(&search(project, "caffè OR secret*")).is_ok());
}

#[test]
fn filters_and_revocation_exclude_inactive_entries_by_default() {
    let (_temporary, path, project, event) = common::database();
    let mut store = MemoryStore::open(path).unwrap();
    let mut entry = common::entry(project, event, "Command", "Run cargo test");
    entry.scope = ["ci".to_owned()].into();
    store.insert(&entry).unwrap();

    let mut filtered = search(project, "cargo");
    filtered.confidence = Some(ConfidenceClass::UserAsserted);
    filtered.scope = Some("ci".to_owned());
    filtered.from = Some(WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap());
    filtered.to = Some(WorkflowTimestamp::parse("2026-08-12T13:00:00Z").unwrap());
    assert_eq!(store.search(&filtered).unwrap(), vec![entry.clone()]);

    store.revoke(project, entry.id).unwrap();
    assert!(store.search(&filtered).unwrap().is_empty());
    filtered.include_inactive = true;
    assert_eq!(
        store.search(&filtered).unwrap()[0].state,
        MemoryState::Revoked
    );
}

#[test]
fn supersession_keeps_old_provenance_but_search_returns_current() {
    let (_temporary, path, project, event) = common::database();
    let mut store = MemoryStore::open(path).unwrap();
    let prior = common::entry(project, event, "Port", "Use port 8000");
    store.insert(&prior).unwrap();
    let replacement = common::entry(project, event, "Port", "Use port 9000");
    store.supersede(project, prior.id, &replacement).unwrap();

    let stored_prior = store.get(project, prior.id).unwrap().unwrap();
    assert_eq!(stored_prior.state, MemoryState::Superseded);
    assert_eq!(
        stored_prior.provenance.source_event_ids,
        prior.provenance.source_event_ids
    );
    assert!(store.search(&search(project, "8000")).unwrap().is_empty());
    assert_eq!(
        store.search(&search(project, "9000")).unwrap(),
        vec![replacement]
    );
}

#[test]
fn source_events_must_exist_in_the_ledger() {
    let (_temporary, path, project, _event) = common::database();
    let mut store = MemoryStore::open(path).unwrap();
    let entry = common::entry(project, EventId::new(), "Invalid", "Missing source");
    assert!(store.insert(&entry).is_err());
}
