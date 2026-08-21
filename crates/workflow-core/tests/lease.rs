use workflow_core::{ActionSafety, Lease, LeaseError, LeaseReconciliation, SessionId, TaskId};

#[test]
fn heartbeat_extends_only_a_valid_lease() {
    let mut lease = Lease::acquire(
        TaskId::new(),
        SessionId::new(),
        100,
        50,
        ActionSafety::Idempotent,
    )
    .unwrap();
    lease.heartbeat(140, 50).unwrap();
    assert_eq!(lease.expires_at_unix_millis(), 190);
    assert_eq!(lease.heartbeat(191, 50), Err(LeaseError::Expired));
}

#[test]
fn reconciliation_never_replays_uncertain_non_idempotent_work() {
    let idempotent = Lease::acquire(
        TaskId::new(),
        SessionId::new(),
        0,
        10,
        ActionSafety::Idempotent,
    )
    .unwrap();
    let non_idempotent = Lease::acquire(
        TaskId::new(),
        SessionId::new(),
        0,
        10,
        ActionSafety::NonIdempotent,
    )
    .unwrap();
    assert_eq!(idempotent.reconcile(11), LeaseReconciliation::Replayable);
    assert_eq!(
        non_idempotent.reconcile(11),
        LeaseReconciliation::ManualReviewRequired
    );
}
