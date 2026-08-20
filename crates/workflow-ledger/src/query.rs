use serde::{Deserialize, Serialize};
use workflow_core::{CandidateId, ProjectId, TaskId, WorkflowId, WorkflowRole, WorkflowTimestamp};

use crate::{Checkpoint, LedgerChain, LedgerEntry};

const MAX_PAGE_SIZE: usize = 1_000;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HistoryFilter {
    pub actor: Option<String>,
    pub candidate_id: Option<CandidateId>,
    pub file: Option<String>,
    pub from: Option<WorkflowTimestamp>,
    pub project_id: Option<ProjectId>,
    pub role: Option<WorkflowRole>,
    pub task_id: Option<TaskId>,
    pub to: Option<WorkflowTimestamp>,
    pub workflow_id: Option<WorkflowId>,
}

impl HistoryFilter {
    fn matches(&self, entry: &LedgerEntry) -> bool {
        let event = &entry.event;
        self.actor
            .as_ref()
            .is_none_or(|actor| &event.actor.id == actor)
            && self
                .candidate_id
                .is_none_or(|candidate| event.candidate_id == Some(candidate))
            && self
                .file
                .as_ref()
                .is_none_or(|file| event.files.contains(file))
            && self.from.is_none_or(|from| event.timestamp >= from)
            && self
                .project_id
                .is_none_or(|project| event.project_id == project)
            && self.role.is_none_or(|role| event.actor.role == Some(role))
            && self.task_id.is_none_or(|task| event.task_id == Some(task))
            && self.to.is_none_or(|to| event.timestamp <= to)
            && self
                .workflow_id
                .is_none_or(|workflow| event.workflow_id == Some(workflow))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct HistoryPage {
    pub entries: Vec<LedgerEntry>,
    pub next_sequence: Option<u64>,
}

#[must_use]
pub fn query(
    chain: &LedgerChain,
    filter: &HistoryFilter,
    after_sequence: Option<u64>,
    limit: usize,
) -> HistoryPage {
    let limit = limit.clamp(1, MAX_PAGE_SIZE);
    let mut matching = chain
        .entries()
        .iter()
        .filter(|entry| after_sequence.is_none_or(|after| entry.sequence > after))
        .filter(|entry| filter.matches(entry));
    let entries: Vec<_> = matching.by_ref().take(limit).cloned().collect();
    let next_sequence = matching
        .next()
        .and_then(|_| entries.last().map(|entry| entry.sequence));
    HistoryPage {
        entries,
        next_sequence,
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryExport {
    pub checkpoints: Vec<Checkpoint>,
    pub entries: Vec<LedgerEntry>,
    pub format_version: u32,
}

impl HistoryExport {
    #[must_use]
    pub fn new(chain: &LedgerChain, checkpoints: Vec<Checkpoint>) -> Self {
        Self {
            checkpoints,
            entries: chain.entries().to_vec(),
            format_version: 1,
        }
    }
}
