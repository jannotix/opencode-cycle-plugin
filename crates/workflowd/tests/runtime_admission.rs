use workflow_core::{ProjectId, WorkflowId};
use workflow_ipc::AdmissionOperation;
use workflowd::{admission::RuntimeAdmission, resources::ResourceSample};

fn healthy() -> ResourceSample {
    ResourceSample {
        available_disk_bytes: Some(100 * 1024 * 1024 * 1024),
        available_memory_bytes: Some(16 * 1024 * 1024 * 1024),
        cpu_usage_percent: Some(10.0),
        owned_processes: None,
    }
}

#[test]
fn runtime_admission_limits_concurrency_and_rotates_projects() {
    let first_project = ProjectId::new();
    let second_project = ProjectId::new();
    let first = WorkflowId::new();
    let second = WorkflowId::new();
    let third = WorkflowId::new();
    let mut admission = RuntimeAdmission::new(1);

    assert!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                first_project,
                first,
                healthy(),
                1_000,
            )
            .admitted
    );
    assert_eq!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                first_project,
                second,
                healthy(),
                1_001,
            )
            .reason,
        Some("concurrency_limit")
    );
    admission.execute(
        AdmissionOperation::Acquire,
        second_project,
        third,
        healthy(),
        1_002,
    );
    admission.execute(
        AdmissionOperation::Release,
        first_project,
        first,
        healthy(),
        1_003,
    );
    assert_eq!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                second_project,
                third,
                healthy(),
                1_004,
            )
            .reason,
        Some("fair_queue")
    );
    assert!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                first_project,
                second,
                healthy(),
                1_005,
            )
            .admitted
    );
    admission.execute(
        AdmissionOperation::Release,
        first_project,
        second,
        healthy(),
        1_006,
    );
    assert!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                second_project,
                third,
                healthy(),
                2_100,
            )
            .admitted
    );
}

#[test]
fn runtime_admission_defers_pressure_and_reaps_expired_leases() {
    let project = ProjectId::new();
    let first = WorkflowId::new();
    let second = WorkflowId::new();
    let mut admission = RuntimeAdmission::new(1);
    let mut pressured = healthy();
    pressured.cpu_usage_percent = Some(99.0);
    assert_eq!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                project,
                first,
                pressured,
                1_000,
            )
            .reason,
        Some("cpu_pressure")
    );
    assert!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                project,
                first,
                healthy(),
                2_000,
            )
            .admitted
    );
    assert!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                project,
                second,
                healthy(),
                17_001,
            )
            .admitted
    );
}

#[test]
fn runtime_admission_reaps_abandoned_waiters() {
    let first_project = ProjectId::new();
    let second_project = ProjectId::new();
    let active = WorkflowId::new();
    let abandoned = WorkflowId::new();
    let live = WorkflowId::new();
    let mut admission = RuntimeAdmission::new(1);

    assert!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                first_project,
                active,
                healthy(),
                1_000,
            )
            .admitted
    );
    admission.execute(
        AdmissionOperation::Acquire,
        first_project,
        abandoned,
        healthy(),
        1_001,
    );
    admission.execute(
        AdmissionOperation::Acquire,
        second_project,
        live,
        healthy(),
        1_002,
    );

    assert!(
        admission
            .execute(
                AdmissionOperation::Acquire,
                second_project,
                live,
                healthy(),
                17_002,
            )
            .admitted
    );
}
