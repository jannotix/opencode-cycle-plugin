use std::{collections::BTreeMap, num::NonZeroUsize};

use tempfile::TempDir;
use workflow_core::{ContentDigest, ProjectId, WorkflowId, WorkflowTimestamp};
use workflow_ledger::{
    Actor, ChainVerification, Checkpoint, CheckpointKey, EventData, LedgerEvent, Redactor,
};
use workflow_store::{Store, StoreError};

fn event(project_id: ProjectId, action: &str) -> LedgerEvent {
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
        project_id,
        None,
        WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap(),
        None,
        &Redactor::default(),
    )
    .unwrap()
}

fn worktree_event(project_id: ProjectId, workflow_id: WorkflowId, revision: &str) -> LedgerEvent {
    let mut metadata = BTreeMap::new();
    metadata.insert(
        "action".to_owned(),
        "execution_worktree_prepared".to_owned(),
    );
    LedgerEvent::new(
        Actor {
            id: "opencode-plugin".to_owned(),
            model: None,
            role: None,
            session_id: None,
        },
        None,
        EventData::Git {
            externally_attributed: false,
            revision: revision.to_owned(),
        },
        [],
        [],
        metadata,
        project_id,
        None,
        WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap(),
        Some(workflow_id),
        &Redactor::default(),
    )
    .unwrap()
}

#[test]
fn ledger_survives_restart_and_verifies() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("workflow.db");
    let project = ProjectId::new();
    let head = {
        let mut store = Store::open(&path, NonZeroUsize::new(2).unwrap()).unwrap();
        store
            .append_ledger_event(event(project, "started"))
            .unwrap();
        store
            .append_ledger_event(event(project, "completed"))
            .unwrap()
            .hash
    };
    let store = Store::open(&path, NonZeroUsize::new(2).unwrap()).unwrap();
    assert_eq!(
        store.load_ledger().unwrap().verify(Some(head)),
        ChainVerification::Valid {
            entries: 2,
            head: Some(head),
        }
    );
}

#[test]
fn checkpoints_must_match_a_persisted_entry() {
    let temporary = TempDir::new().unwrap();
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    let entry = store
        .append_ledger_event(event(ProjectId::new(), "started"))
        .unwrap();
    let key = CheckpointKey::from_seed(&[9; 32]);
    let valid = Checkpoint::sign(
        entry.sequence,
        entry.hash,
        WorkflowTimestamp::parse("2026-08-12T12:00:01Z").unwrap(),
        &key,
    );
    store.save_checkpoint(&valid).unwrap();
    assert_eq!(store.load_checkpoints().unwrap(), vec![valid]);

    let invalid = Checkpoint::sign(
        entry.sequence,
        ContentDigest::of(b"not-the-entry"),
        WorkflowTimestamp::parse("2026-08-12T12:00:02Z").unwrap(),
        &key,
    );
    assert!(matches!(
        store.save_checkpoint(&invalid),
        Err(StoreError::LedgerCheckpoint)
    ));
}

#[test]
fn latest_worktree_base_revision_is_recovered_from_the_bound_ledger_event() {
    let temporary = TempDir::new().unwrap();
    let mut store = Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    let project_id = ProjectId::new();
    let workflow_id = WorkflowId::new();
    let first = "1".repeat(40);
    let latest = "2".repeat(40);
    store
        .append_ledger_event(worktree_event(project_id, workflow_id, &first))
        .unwrap();
    store
        .append_ledger_event(worktree_event(project_id, workflow_id, &latest))
        .unwrap();
    store
        .append_ledger_event(event(project_id, "unrelated"))
        .unwrap();

    assert_eq!(
        store.load_worktree_base_revision(workflow_id).unwrap(),
        Some(latest)
    );
    assert_eq!(
        store
            .load_worktree_base_revision(WorkflowId::new())
            .unwrap(),
        None
    );
}
