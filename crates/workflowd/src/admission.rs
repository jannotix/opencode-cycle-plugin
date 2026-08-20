use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Serialize;
use workflow_core::{ProjectId, WorkflowId};
use workflow_ipc::AdmissionOperation;

use crate::resources::{
    ResourceSample,
    policy::{AdmissionController, AdmissionDecision, ResourceDemand, ResourcePolicy, WorkKind},
};

const LEASE_MILLIS: u64 = 15_000;
const RETRY_MILLIS: u64 = 500;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionResult {
    pub active: usize,
    pub admitted: bool,
    pub lease_expires_unix_millis: Option<u64>,
    pub maximum_active: usize,
    pub reason: Option<&'static str>,
    pub retry_after_millis: u64,
}

struct ActiveLease {
    expires_at: u64,
}

pub struct RuntimeAdmission {
    active: BTreeMap<WorkflowId, ActiveLease>,
    controller: AdmissionController,
    last_tick: u64,
    maximum_active: usize,
    projects: BTreeMap<ProjectId, VecDeque<WorkflowId>>,
    rotation: VecDeque<ProjectId>,
    waiting: BTreeMap<WorkflowId, u64>,
    workflow_projects: BTreeMap<WorkflowId, ProjectId>,
}

impl Default for RuntimeAdmission {
    fn default() -> Self {
        let logical_cpus = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
        Self::new(logical_cpus.div_ceil(2).clamp(1, 8))
    }
}

impl RuntimeAdmission {
    #[must_use]
    pub fn new(maximum_active: usize) -> Self {
        Self {
            active: BTreeMap::new(),
            controller: AdmissionController::new(ResourcePolicy {
                disk_reserve_bytes: 2 * 1024 * 1024 * 1024,
                max_cpu_percent: 85.0,
                memory_reserve_bytes: 1024 * 1024 * 1024,
                recovery_admissions_per_tick: 1,
            }),
            last_tick: 0,
            maximum_active: maximum_active.max(1),
            projects: BTreeMap::new(),
            rotation: VecDeque::new(),
            waiting: BTreeMap::new(),
            workflow_projects: BTreeMap::new(),
        }
    }

    pub fn execute(
        &mut self,
        operation: AdmissionOperation,
        project_id: ProjectId,
        workflow_id: WorkflowId,
        sample: ResourceSample,
        now_unix_millis: u64,
    ) -> AdmissionResult {
        self.reap(now_unix_millis);
        if operation == AdmissionOperation::Release {
            self.remove(workflow_id);
            return self.result(false, None, Some("released"));
        }
        if let Some(lease) = self.active.get_mut(&workflow_id) {
            lease.expires_at = now_unix_millis.saturating_add(LEASE_MILLIS);
            let expires_at = lease.expires_at;
            return self.result(true, Some(expires_at), None);
        }
        self.enqueue(project_id, workflow_id, now_unix_millis);
        if self.active.len() >= self.maximum_active {
            return self.result(false, None, Some("concurrency_limit"));
        }
        if self.rotation.front().copied() != Some(project_id)
            || self
                .projects
                .get(&project_id)
                .and_then(|queue| queue.front())
                .copied()
                != Some(workflow_id)
        {
            return self.result(false, None, Some("fair_queue"));
        }
        if now_unix_millis.saturating_sub(self.last_tick) >= 1_000 {
            self.controller.begin_tick();
            self.last_tick = now_unix_millis;
        }
        let decision = self.controller.evaluate(
            sample,
            ResourceDemand {
                disk_bytes: 512 * 1024 * 1024,
                kind: WorkKind::RemoteModel,
                memory_bytes: 512 * 1024 * 1024,
            },
            false,
        );
        if decision != AdmissionDecision::Admit {
            return self.result(false, None, Some(reason(decision)));
        }
        self.dequeue_front(project_id, workflow_id);
        let expires_at = now_unix_millis.saturating_add(LEASE_MILLIS);
        self.active.insert(workflow_id, ActiveLease { expires_at });
        self.result(true, Some(expires_at), None)
    }

    fn enqueue(&mut self, project_id: ProjectId, workflow_id: WorkflowId, now_unix_millis: u64) {
        let expires_at = now_unix_millis.saturating_add(LEASE_MILLIS);
        if let Some(expiration) = self.waiting.get_mut(&workflow_id) {
            *expiration = expires_at;
            return;
        }
        self.waiting.insert(workflow_id, expires_at);
        let new_project = !self.projects.contains_key(&project_id);
        self.projects
            .entry(project_id)
            .or_default()
            .push_back(workflow_id);
        self.workflow_projects.insert(workflow_id, project_id);
        if new_project {
            self.rotation.push_back(project_id);
        }
    }

    fn dequeue_front(&mut self, project_id: ProjectId, workflow_id: WorkflowId) {
        let queue = self
            .projects
            .get_mut(&project_id)
            .expect("queued project exists");
        debug_assert_eq!(queue.pop_front(), Some(workflow_id));
        self.waiting.remove(&workflow_id);
        self.workflow_projects.remove(&workflow_id);
        self.rotation.pop_front();
        if queue.is_empty() {
            self.projects.remove(&project_id);
        } else {
            self.rotation.push_back(project_id);
        }
    }

    fn reap(&mut self, now_unix_millis: u64) {
        self.active
            .retain(|_, lease| lease.expires_at > now_unix_millis);
        let abandoned = self
            .waiting
            .iter()
            .filter_map(|(workflow_id, expires_at)| {
                (*expires_at <= now_unix_millis).then_some(*workflow_id)
            })
            .collect::<Vec<_>>();
        for workflow_id in abandoned {
            self.remove(workflow_id);
        }
        self.repair_queue_invariants();
    }

    fn repair_queue_invariants(&mut self) {
        for (project_id, queue) in &mut self.projects {
            queue.retain(|workflow_id| {
                self.waiting.contains_key(workflow_id)
                    && self.workflow_projects.get(workflow_id) == Some(project_id)
            });
        }
        self.projects.retain(|_, queue| !queue.is_empty());

        let queued = self
            .projects
            .iter()
            .flat_map(|(project_id, queue)| {
                queue
                    .iter()
                    .map(move |workflow_id| (*workflow_id, *project_id))
            })
            .collect::<BTreeMap<_, _>>();
        self.waiting
            .retain(|workflow_id, _| queued.contains_key(workflow_id));
        self.workflow_projects
            .retain(|workflow_id, project_id| queued.get(workflow_id) == Some(project_id));

        let mut seen = BTreeSet::new();
        self.rotation.retain(|project_id| {
            self.projects.contains_key(project_id) && seen.insert(*project_id)
        });
        for project_id in self.projects.keys() {
            if seen.insert(*project_id) {
                self.rotation.push_back(*project_id);
            }
        }
    }

    fn remove(&mut self, workflow_id: WorkflowId) {
        self.active.remove(&workflow_id);
        let Some(project_id) = self.workflow_projects.remove(&workflow_id) else {
            return;
        };
        self.waiting.remove(&workflow_id);
        if let Some(queue) = self.projects.get_mut(&project_id) {
            queue.retain(|queued| *queued != workflow_id);
            if queue.is_empty() {
                self.projects.remove(&project_id);
                self.rotation.retain(|queued| *queued != project_id);
            }
        }
    }

    pub fn release(&mut self, workflow_id: WorkflowId) {
        self.remove(workflow_id);
    }

    fn result(
        &self,
        admitted: bool,
        lease_expires_unix_millis: Option<u64>,
        reason: Option<&'static str>,
    ) -> AdmissionResult {
        AdmissionResult {
            active: self.active.len(),
            admitted,
            lease_expires_unix_millis,
            maximum_active: self.maximum_active,
            reason,
            retry_after_millis: if admitted { 0 } else { RETRY_MILLIS },
        }
    }
}

const fn reason(decision: AdmissionDecision) -> &'static str {
    match decision {
        AdmissionDecision::Admit => "admitted",
        AdmissionDecision::DeferCpu => "cpu_pressure",
        AdmissionDecision::DeferDisk => "disk_pressure",
        AdmissionDecision::DeferIndexing => "verification_priority",
        AdmissionDecision::DeferMemory => "memory_pressure",
        AdmissionDecision::DeferMetricsUnavailable => "metrics_unavailable",
        AdmissionDecision::DeferRecoveryBackpressure => "recovery_backpressure",
    }
}

#[cfg(test)]
mod tests {
    use workflow_core::{ProjectId, WorkflowId};
    use workflow_ipc::AdmissionOperation;

    use super::RuntimeAdmission;
    use crate::resources::ResourceSample;

    #[test]
    fn ghost_rotation_cannot_block_an_idle_scheduler() {
        let mut admission = RuntimeAdmission::new(1);
        admission.rotation.push_back(ProjectId::new());
        let result = admission.execute(
            AdmissionOperation::Acquire,
            ProjectId::new(),
            WorkflowId::new(),
            ResourceSample {
                available_disk_bytes: Some(100 * 1024 * 1024 * 1024),
                available_memory_bytes: Some(16 * 1024 * 1024 * 1024),
                cpu_usage_percent: Some(10.0),
                owned_processes: None,
            },
            1_000,
        );

        assert!(result.admitted);
        assert_eq!(result.active, 1);
    }
}
