use super::ResourceSample;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkKind {
    RemoteModel,
    LocalModel,
    Build,
    Browser,
    Database,
    Indexing,
    Verification,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResourceDemand {
    pub disk_bytes: u64,
    pub kind: WorkKind,
    pub memory_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResourcePolicy {
    pub disk_reserve_bytes: u64,
    pub max_cpu_percent: f32,
    pub memory_reserve_bytes: u64,
    pub recovery_admissions_per_tick: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionDecision {
    Admit,
    DeferCpu,
    DeferDisk,
    DeferIndexing,
    DeferMemory,
    DeferMetricsUnavailable,
    DeferRecoveryBackpressure,
}

pub struct AdmissionController {
    admitted_this_tick: u16,
    policy: ResourcePolicy,
    pressured_last_tick: bool,
    recovery_tick: bool,
}

impl AdmissionController {
    #[must_use]
    pub const fn new(policy: ResourcePolicy) -> Self {
        Self {
            admitted_this_tick: 0,
            policy,
            pressured_last_tick: false,
            recovery_tick: false,
        }
    }

    pub fn begin_tick(&mut self) {
        self.admitted_this_tick = 0;
        self.recovery_tick = self.pressured_last_tick;
        self.pressured_last_tick = false;
    }

    pub fn evaluate(
        &mut self,
        sample: ResourceSample,
        demand: ResourceDemand,
        verification_waiting: bool,
    ) -> AdmissionDecision {
        if demand.kind == WorkKind::Indexing && verification_waiting {
            return AdmissionDecision::DeferIndexing;
        }
        let Some(memory) = sample.available_memory_bytes else {
            return AdmissionDecision::DeferMetricsUnavailable;
        };
        let Some(disk) = sample.available_disk_bytes else {
            return AdmissionDecision::DeferMetricsUnavailable;
        };
        let Some(cpu) = sample.cpu_usage_percent else {
            return AdmissionDecision::DeferMetricsUnavailable;
        };
        if memory
            < self
                .policy
                .memory_reserve_bytes
                .saturating_add(demand.memory_bytes)
        {
            self.pressured_last_tick = true;
            return AdmissionDecision::DeferMemory;
        }
        if disk
            < self
                .policy
                .disk_reserve_bytes
                .saturating_add(demand.disk_bytes)
        {
            self.pressured_last_tick = true;
            return AdmissionDecision::DeferDisk;
        }
        if cpu > self.policy.max_cpu_percent {
            self.pressured_last_tick = true;
            return AdmissionDecision::DeferCpu;
        }
        if self.recovery_tick && self.admitted_this_tick >= self.policy.recovery_admissions_per_tick
        {
            return AdmissionDecision::DeferRecoveryBackpressure;
        }
        self.admitted_this_tick = self.admitted_this_tick.saturating_add(1);
        AdmissionDecision::Admit
    }
}
