use std::collections::BTreeMap;

use workflowd::scheduler::classes::{CapacityDecision, CapacityLimiter, WorkClass};

#[test]
fn work_classes_enforce_independent_caps() {
    let build = WorkClass::Build;
    let browser = WorkClass::Browser;
    let mut limiter =
        CapacityLimiter::new(BTreeMap::from([(build.clone(), 1), (browser.clone(), 1)]));
    assert_eq!(limiter.try_admit(&build, 0), CapacityDecision::Admitted);
    assert_eq!(limiter.try_admit(&build, 0), CapacityDecision::AtCapacity);
    assert_eq!(limiter.try_admit(&browser, 0), CapacityDecision::Admitted);
    assert!(limiter.release(&build));
    assert_eq!(limiter.try_admit(&build, 0), CapacityDecision::Admitted);
}

#[test]
fn provider_backoff_does_not_block_unrelated_providers() {
    let first = WorkClass::RemoteModel("first".to_owned());
    let second = WorkClass::RemoteModel("second".to_owned());
    let mut limiter =
        CapacityLimiter::new(BTreeMap::from([(first.clone(), 2), (second.clone(), 2)]));
    limiter.backoff_provider("first".to_owned(), 100);
    assert_eq!(
        limiter.try_admit(&first, 50),
        CapacityDecision::ProviderBackoff
    );
    assert_eq!(limiter.try_admit(&second, 50), CapacityDecision::Admitted);
    assert_eq!(limiter.try_admit(&first, 100), CapacityDecision::Admitted);
}
