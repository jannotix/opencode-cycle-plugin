use workflowd::resources::sample;

#[test]
fn sampler_reports_real_host_metrics_without_synthetic_zeroes() {
    let sample = sample(std::env::current_dir().unwrap().as_path());
    assert!(sample.available_memory_bytes.is_none_or(|value| value > 0));
    assert!(sample.available_disk_bytes.is_none_or(|value| value > 0));
    assert!(
        sample
            .cpu_usage_percent
            .is_none_or(|value| (0.0..=100.0).contains(&value))
    );
    assert!(sample.owned_processes.is_none_or(|value| value >= 1));
}

#[test]
fn unknown_mount_returns_explicit_absence() {
    #[cfg(windows)]
    let path = std::path::Path::new(r"\\unavailable.invalid\share\path");
    #[cfg(not(windows))]
    let path = std::path::Path::new("/path-that-does-not-exist");
    let sample = sample(path);
    #[cfg(not(windows))]
    assert!(sample.available_disk_bytes.is_some());
    #[cfg(windows)]
    assert!(sample.available_disk_bytes.is_none());
}
