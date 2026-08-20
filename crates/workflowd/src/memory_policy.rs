use std::collections::BTreeSet;

use workflow_core::{CandidateId, EventId, EvidenceId, MemoryId, ProjectId, WorkflowTimestamp};
use workflow_memory::{
    ConfidenceClass, MemoryEntry, MemoryError, MemoryKind, MemoryState, Provenance,
};

pub struct AutomaticMemoryCandidate {
    pub actor: String,
    pub candidate_id: CandidateId,
    pub detail: String,
    pub evidence_ids: BTreeSet<EvidenceId>,
    pub kind: MemoryKind,
    pub project_id: ProjectId,
    pub revision: Option<String>,
    pub scope: BTreeSet<String>,
    pub source_event_ids: BTreeSet<EventId>,
    pub summary: String,
    pub title: String,
    pub verified_at: WorkflowTimestamp,
}

pub fn qualify(candidate: AutomaticMemoryCandidate) -> Result<MemoryEntry, MemoryError> {
    let entry = MemoryEntry {
        actor: candidate.actor,
        confidence: ConfidenceClass::Verified,
        created_at: candidate.verified_at,
        detail: candidate.detail,
        id: MemoryId::new(),
        kind: candidate.kind,
        project_id: candidate.project_id,
        provenance: Provenance {
            candidate_id: Some(candidate.candidate_id),
            evidence_ids: candidate.evidence_ids,
            revision: candidate.revision,
            source_event_ids: candidate.source_event_ids,
        },
        scope: candidate.scope,
        state: MemoryState::Current,
        summary: candidate.summary,
        superseded_by: None,
        title: candidate.title,
    };
    entry.validate()?;
    Ok(entry)
}
