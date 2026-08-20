use std::collections::{BTreeMap, BTreeSet, VecDeque};

use workflow_core::{ProjectId, TaskId, WorkflowId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SchedulingState {
    Ready,
    Paused,
    Blocked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScheduledTask {
    pub priority: i16,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub workflow_id: WorkflowId,
}

#[derive(Clone, Copy)]
struct Entry {
    sequence: u64,
    state: SchedulingState,
    task: ScheduledTask,
}

pub struct FairQueue {
    projects: BTreeMap<ProjectId, Vec<Entry>>,
    rotation: VecDeque<ProjectId>,
    sequence: u64,
    tasks: BTreeSet<TaskId>,
}

impl Default for FairQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl FairQueue {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            projects: BTreeMap::new(),
            rotation: VecDeque::new(),
            sequence: 0,
            tasks: BTreeSet::new(),
        }
    }

    pub fn enqueue(&mut self, task: ScheduledTask, state: SchedulingState) -> bool {
        if !self.tasks.insert(task.task_id) {
            return false;
        }
        let is_new_project = !self.projects.contains_key(&task.project_id);
        let entry = Entry {
            sequence: self.sequence,
            state,
            task,
        };
        self.sequence = self.sequence.saturating_add(1);
        self.projects
            .entry(task.project_id)
            .or_default()
            .push(entry);
        if is_new_project {
            self.rotation.push_back(task.project_id);
        }
        true
    }

    pub fn set_workflow_state(&mut self, workflow_id: WorkflowId, state: SchedulingState) {
        for entries in self.projects.values_mut() {
            for entry in entries
                .iter_mut()
                .filter(|entry| entry.task.workflow_id == workflow_id)
            {
                entry.state = state;
            }
        }
    }

    pub fn pop(&mut self) -> Option<ScheduledTask> {
        let projects_to_check = self.rotation.len();
        for _ in 0..projects_to_check {
            let project_id = self.rotation.pop_front()?;
            let entries = self.projects.get_mut(&project_id)?;
            let selected = entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| entry.state == SchedulingState::Ready)
                .max_by_key(|(_, entry)| (entry.task.priority, std::cmp::Reverse(entry.sequence)))
                .map(|(index, _)| index);
            if let Some(index) = selected {
                let entry = entries.remove(index);
                self.tasks.remove(&entry.task.task_id);
                if entries.is_empty() {
                    self.projects.remove(&project_id);
                } else {
                    self.rotation.push_back(project_id);
                }
                return Some(entry.task);
            }
            self.rotation.push_back(project_id);
        }
        None
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }
}
