use workflowd::resources::{
    ResourceSample,
    policy::{AdmissionController, AdmissionDecision, ResourceDemand, ResourcePolicy, WorkKind},
};

fn sample(memory: Option<u64>, disk: Option<u64>, cpu: Option<f32>) -> ResourceSample {
    ResourceSample {
        available_disk_bytes: disk,
        available_memory_bytes: memory,
        cpu_usage_percent: cpu,
        owned_processes: Some(1),
    }
}

fn controller() -> AdmissionController {
    AdmissionController::new(ResourcePolicy {
        disk_reserve_bytes: 100,
        max_cpu_percent: 90.0,
        memory_reserve_bytes: 100,
        recovery_admissions_per_tick: 1,
    })
}

#[test]
fn memory_disk_and_missing_metrics_block_admission() {
    let demand = ResourceDemand {
        disk_bytes: 20,
        kind: WorkKind::Build,
        memory_bytes: 20,
    };
    let mut controller = controller();
    assert_eq!(
        controller.evaluate(sample(Some(119), Some(200), Some(10.0)), demand, false),
        AdmissionDecision::DeferMemory
    );
    assert_eq!(
        controller.evaluate(sample(Some(200), Some(119), Some(10.0)), demand, false),
        AdmissionDecision::DeferDisk
    );
    assert_eq!(
        controller.evaluate(sample(None, Some(200), Some(10.0)), demand, false),
        AdmissionDecision::DeferMetricsUnavailable
    );
}

#[test]
fn indexing_yields_to_verification() {
    let mut controller = controller();
    let demand = ResourceDemand {
        disk_bytes: 0,
        kind: WorkKind::Indexing,
        memory_bytes: 0,
    };
    assert_eq!(
        controller.evaluate(sample(Some(1_000), Some(1_000), Some(10.0)), demand, true),
        AdmissionDecision::DeferIndexing
    );
}

#[test]
fn recovery_tick_admits_gradually_without_a_thundering_herd() {
    let mut controller = controller();
    let demand = ResourceDemand {
        disk_bytes: 20,
        kind: WorkKind::Build,
        memory_bytes: 20,
    };
    controller.begin_tick();
    assert_eq!(
        controller.evaluate(sample(Some(10), Some(1_000), Some(10.0)), demand, false),
        AdmissionDecision::DeferMemory
    );
    controller.begin_tick();
    let healthy = sample(Some(1_000), Some(1_000), Some(10.0));
    assert_eq!(
        controller.evaluate(healthy, demand, false),
        AdmissionDecision::Admit
    );
    assert_eq!(
        controller.evaluate(healthy, demand, false),
        AdmissionDecision::DeferRecoveryBackpressure
    );
    controller.begin_tick();
    assert_eq!(
        controller.evaluate(healthy, demand, false),
        AdmissionDecision::Admit
    );
}
