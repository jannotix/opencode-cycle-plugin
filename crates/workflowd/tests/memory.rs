use std::{collections::BTreeSet, num::NonZeroUsize};

use tempfile::TempDir;
use workflow_core::{CandidateId, EvidenceId, ProjectId, WorkflowTimestamp};
use workflow_ipc::{audit::AuditData, audit::AuditObservation, protocol::MemoryOperation};
use workflow_ledger::CheckpointKey;
use workflow_memory::{ConfidenceClass, MemoryKind, MemoryStore};
use workflow_store::Store;
use workflowd::memory_policy::{AutomaticMemoryCandidate, qualify};

fn candidate(project_id: ProjectId, event_id: workflow_core::EventId) -> AutomaticMemoryCandidate {
    AutomaticMemoryCandidate {
        actor: "arbiter".to_owned(),
        candidate_id: CandidateId::new(),
        detail: "The verified build command completes successfully".to_owned(),
        evidence_ids: BTreeSet::from([EvidenceId::new()]),
        kind: MemoryKind::Command,
        project_id,
        revision: Some("abc123".to_owned()),
        scope: BTreeSet::from(["build".to_owned()]),
        source_event_ids: BTreeSet::from([event_id]),
        summary: "Use cargo test for verification".to_owned(),
        title: "Verified build command".to_owned(),
        verified_at: WorkflowTimestamp::parse("2026-08-12T12:01:00Z").unwrap(),
    }
}

#[test]
fn automatic_memory_requires_evidence_and_rejects_secrets() {
    let project = ProjectId::new();
    let event = workflow_core::EventId::new();
    let mut missing_evidence = candidate(project, event);
    missing_evidence.evidence_ids.clear();
    assert!(qualify(missing_evidence).is_err());

    let mut sensitive = candidate(project, event);
    sensitive.detail = "Bearer private-token".to_owned();
    assert!(qualify(sensitive).is_err());

    let accepted = qualify(candidate(project, event)).unwrap();
    assert_eq!(accepted.confidence, ConfidenceClass::Verified);
}

#[test]
fn native_memory_commands_search_explain_and_revoke() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("workflow.db");
    let project_key = "project";
    let project_id = ProjectId::from_stable_key(project_key);
    let mut store = Store::open(&path, NonZeroUsize::new(2).unwrap()).unwrap();
    let checkpoint_key = CheckpointKey::from_seed(&[7; 32]);
    let ledger = workflowd::audit::record(
        &mut store,
        &checkpoint_key,
        AuditObservation {
            actor_id: "test".to_owned(),
            candidate_id: None,
            data: AuditData::Workflow {
                action: "completed".to_owned(),
            },
            evidence_ids: Default::default(),
            files: Default::default(),
            metadata: Default::default(),
            model: None,
            project_key: project_key.to_owned(),
            role: None,
            session_id: None,
            task_id: None,
            timestamp_unix_millis: 1_786_519_330_123,
            workflow_id: None,
        },
    )
    .unwrap();
    drop(store);
    let entry = qualify(candidate(project_id, ledger.event.event_id)).unwrap();
    let id = entry.id;
    let mut memory = MemoryStore::open(&path).unwrap();
    memory.insert(&entry).unwrap();
    drop(memory);

    let result = workflowd::memory::execute(
        &path,
        project_key,
        MemoryOperation::Search {
            confidence: Some("verified".to_owned()),
            limit: 10,
            scope: Some("build".to_owned()),
            text: "cargo".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 1);
    let explained = workflowd::memory::execute(
        &path,
        project_key,
        MemoryOperation::Explain { memory_id: id },
    )
    .unwrap();
    assert_eq!(explained["entry"]["id"], id.to_string());

    workflowd::memory::execute(
        &path,
        project_key,
        MemoryOperation::Remove { memory_id: id },
    )
    .unwrap();
    let result = workflowd::memory::execute(
        &path,
        project_key,
        MemoryOperation::Search {
            confidence: None,
            limit: 10,
            scope: None,
            text: String::new(),
        },
    )
    .unwrap();
    assert!(result["entries"].as_array().unwrap().is_empty());
}
