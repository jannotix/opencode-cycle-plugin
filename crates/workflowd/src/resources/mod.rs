pub mod policy;

use std::path::Path;

use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResourceSample {
    pub available_disk_bytes: Option<u64>,
    pub available_memory_bytes: Option<u64>,
    pub cpu_usage_percent: Option<f32>,
    pub owned_processes: Option<u32>,
}

pub fn sample(workspace: &Path) -> ResourceSample {
    let mut system = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();
    let cpu_usage_percent = (!system.cpus().is_empty()).then(|| system.global_cpu_usage());
    let available_memory_bytes = (system.total_memory() > 0).then(|| system.available_memory());
    let available_disk_bytes = Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| workspace.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(sysinfo::Disk::available_space);
    ResourceSample {
        available_disk_bytes,
        available_memory_bytes,
        cpu_usage_percent,
        owned_processes: None,
    }
}
