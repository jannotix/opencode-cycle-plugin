use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use sysinfo::{Disks, ProcessesToUpdate, System};
use workflow_code_intel::{
    ContextBudget, ContextLevel, IgnorePolicy, context_bundle,
    graph::{GraphStore, NodeKind, PartitionId},
    index_project, neighbors,
};
use workflow_core::ProjectId;

const DEFAULT_SOURCE_FILES: u64 = 500_100;
const DEFAULT_IGNORED_FILES: u64 = 20_000;
const FILES_PER_PARTITION: u64 = 1_000;
const MAX_DURATION: Duration = Duration::from_secs(30 * 60);
const EXTENSIONS: &[&str] = &[
    "ts", "tsx", "py", "rs", "go", "java", "kt", "cs", "c", "cpp", "php", "rb", "swift", "dart",
    "sql", "html", "css", "sh", "ps1", "json", "yaml", "toml", "xml",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Results {
    corpus: CorpusResults,
    graph: GraphResults,
    hardware: HardwareResults,
    incremental: IncrementalResults,
    passed: bool,
    resources: ResourceResults,
    schema_version: u32,
    timings_ms: TimingResults,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusResults {
    deterministic_seed: u64,
    ignored_files: u64,
    inventoried_files: u64,
    parsed_files: u64,
    physical_files: u64,
    source_files: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphResults {
    context_bytes: usize,
    context_items: usize,
    edges: u64,
    nodes: u64,
    oracle_route_found: bool,
    parse_errors: u64,
    partitions: u64,
    query_nodes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HardwareResults {
    cpu: String,
    logical_cpus: usize,
    operating_system: String,
    total_memory_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IncrementalResults {
    deleted_removed: bool,
    modified_found: bool,
    partition_generation: u64,
    renamed_found: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceResults {
    available_disk_bytes_after: Option<u64>,
    generated_bytes: u64,
    peak_cpu_percent: f32,
    peak_memory_bytes: u64,
    peak_memory_percent: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimingResults {
    generation: u128,
    hashing: u128,
    incremental: u128,
    inventory_and_index: u128,
    parsing: u128,
    persistence: u128,
    query: u128,
    total: u128,
}

fn main() {
    let options = options();
    let total_started = Instant::now();
    let output = options.output.clone();
    let temporary = tempfile::tempdir().expect("benchmark temporary directory must be available");
    let corpus = temporary.path().join("corpus");
    fs::create_dir(&corpus).expect("benchmark corpus root must be created");
    let sampler = ResourceSampler::start();

    let generation_started = Instant::now();
    let generated_bytes = generate_corpus(&corpus, options.source_files, options.ignored_files);
    let generation_time = generation_started.elapsed();

    let database = temporary.path().join("code-intelligence.db");
    drop(
        workflow_store::Store::open(&database, NonZeroUsize::new(2).unwrap())
            .expect("benchmark database schema must initialize"),
    );
    let project_id = ProjectId::new();
    let policy =
        IgnorePolicy::new(&corpus, [], 1024 * 1024).expect("benchmark ignore policy must compile");
    let mut graph_store = GraphStore::open(&database).expect("benchmark graph store must open");
    let workers = NonZeroUsize::new(
        thread::available_parallelism()
            .map(NonZeroUsize::get)
            .unwrap_or(1)
            .min(16),
    )
    .unwrap();
    let index_report = index_project(
        &corpus,
        &policy,
        &mut graph_store,
        project_id,
        &BTreeSet::new(),
        workers,
    )
    .expect("benchmark inventory and index must complete");

    let oracle_scope = "src/partition-000000";
    let oracle_partition_id = PartitionId::new(project_id, oracle_scope);
    let query_started = Instant::now();
    let oracle_partition = graph_store
        .load_partition(oracle_partition_id)
        .expect("oracle partition must be readable")
        .expect("oracle partition must exist");
    let oracle_route_found = oracle_partition
        .nodes
        .values()
        .any(|node| node.kind == NodeKind::Route);
    let selected = oracle_partition
        .nodes
        .keys()
        .copied()
        .take(250)
        .collect::<BTreeSet<_>>();
    let context = context_bundle(
        &oracle_partition,
        &selected,
        ContextLevel::Inventory,
        &BTreeMap::new(),
        ContextBudget {
            max_bytes: 32 * 1024,
            max_items: 200,
        },
    );
    let query_node = oracle_partition
        .edges
        .values()
        .next()
        .map(|edge| edge.source)
        .or_else(|| oracle_partition.nodes.keys().next().copied())
        .expect("oracle partition must contain nodes");
    let query = neighbors(
        &oracle_partition,
        query_node,
        workflow_code_intel::TraversalDirection::Outgoing,
        100,
    );
    let query_time = query_started.elapsed();

    let incremental_started = Instant::now();
    let first = corpus.join("src/partition-000000/file-000000000.ts");
    let second = corpus.join("src/partition-000000/file-000000001.tsx");
    let renamed = corpus.join("src/partition-000000/file-000000001-renamed.tsx");
    let third = corpus.join("src/partition-000000/file-000000002.py");
    fs::write(&first, "export const modified = true;\n").expect("oracle file must be writable");
    fs::rename(&second, &renamed).expect("oracle file must be renameable");
    fs::remove_file(&third).expect("oracle file must be removable");
    let forced = [
        "src/partition-000000/file-000000000.ts",
        "src/partition-000000/file-000000001.tsx",
        "src/partition-000000/file-000000001-renamed.tsx",
        "src/partition-000000/file-000000002.py",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let incremental_report = index_project(
        &corpus,
        &policy,
        &mut graph_store,
        project_id,
        &forced,
        workers,
    )
    .expect("incremental benchmark index must complete");
    let incremental_partition = graph_store
        .load_partition(oracle_partition_id)
        .expect("incremental oracle partition must be readable")
        .expect("incremental oracle partition must exist");
    let incremental_time = incremental_started.elapsed();
    let modified_found = incremental_partition
        .nodes
        .values()
        .any(|node| node.source_path.ends_with("file-000000000.ts"));
    let renamed_found = incremental_partition
        .nodes
        .values()
        .any(|node| node.source_path.ends_with("file-000000001-renamed.tsx"));
    let deleted_removed = incremental_partition
        .nodes
        .values()
        .all(|node| !node.source_path.ends_with("file-000000002.py"));

    let resources = sampler.stop(&corpus, generated_bytes);
    let total_time = total_started.elapsed();
    let physical_files = options.source_files + options.ignored_files + 1;
    let passed = physical_files > 500_000
        && index_report.inventory.files > 500_000
        && index_report.parsed_files == options.source_files
        && index_report.parse_errors == 0
        && oracle_route_found
        && !query.nodes.is_empty()
        && modified_found
        && renamed_found
        && deleted_removed
        && resources.peak_memory_percent <= 80.0
        && index_report.timings.total <= MAX_DURATION
        && total_time <= MAX_DURATION;
    let system = System::new_all();
    let results = Results {
        corpus: CorpusResults {
            deterministic_seed: 20_260_812,
            ignored_files: options.ignored_files,
            inventoried_files: index_report.inventory.files,
            parsed_files: index_report.parsed_files,
            physical_files,
            source_files: options.source_files,
        },
        graph: GraphResults {
            context_bytes: context.bytes,
            context_items: context.items.len(),
            edges: index_report.edges,
            nodes: index_report.nodes,
            oracle_route_found,
            parse_errors: index_report.parse_errors,
            partitions: index_report.persisted_partitions,
            query_nodes: query.nodes.len(),
        },
        hardware: HardwareResults {
            cpu: system
                .cpus()
                .first()
                .map_or_else(|| "unknown".to_owned(), |cpu| cpu.brand().to_owned()),
            logical_cpus: system.cpus().len(),
            operating_system: System::long_os_version().unwrap_or_else(|| "unknown".to_owned()),
            total_memory_bytes: system.total_memory(),
        },
        incremental: IncrementalResults {
            deleted_removed,
            modified_found,
            partition_generation: incremental_report.maximum_generation,
            renamed_found,
        },
        passed,
        resources,
        schema_version: 1,
        timings_ms: TimingResults {
            generation: generation_time.as_millis(),
            hashing: index_report.timings.hashing.as_millis(),
            incremental: incremental_time.as_millis(),
            inventory_and_index: index_report.timings.total.as_millis(),
            parsing: index_report.timings.parsing.as_millis(),
            persistence: index_report.timings.persistence.as_millis(),
            query: query_time.as_millis(),
            total: total_time.as_millis(),
        },
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("benchmark result directory must be created");
    }
    fs::write(
        &output,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&results).expect("benchmark results must serialize")
        ),
    )
    .expect("benchmark results must be written");
    if !passed {
        eprintln!(
            "500k codebase certification failed; inspect {}",
            output.display()
        );
        std::process::exit(1);
    }
}

struct Options {
    ignored_files: u64,
    output: PathBuf,
    source_files: u64,
}

fn options() -> Options {
    let mut source_files = DEFAULT_SOURCE_FILES;
    let mut ignored_files = DEFAULT_IGNORED_FILES;
    let mut output = None;
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--source-files" => {
                source_files = value(&arguments, index)
                    .parse()
                    .expect("source file count must be numeric")
            }
            "--ignored-files" => {
                ignored_files = value(&arguments, index)
                    .parse()
                    .expect("ignored file count must be numeric")
            }
            "--output" => output = Some(PathBuf::from(value(&arguments, index))),
            argument => panic!("unknown benchmark argument: {argument}"),
        }
        index += 2;
    }
    assert!(source_files > 0, "source file count must be positive");
    assert!(ignored_files > 0, "ignored file count must be positive");
    Options {
        ignored_files,
        output: output.expect("expected --output <path>"),
        source_files,
    }
}

fn value(arguments: &[String], index: usize) -> &str {
    arguments
        .get(index + 1)
        .map(String::as_str)
        .expect("benchmark argument requires a value")
}

fn generate_corpus(root: &Path, source_files: u64, ignored_files: u64) -> u64 {
    let partitions = source_files.div_ceil(FILES_PER_PARTITION);
    let available_workers = thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(1);
    let worker_count = generation_worker_count(source_files, available_workers);
    let next_partition = AtomicU64::new(0);
    let generated_bytes = AtomicU64::new(0);
    thread::scope(|scope| {
        for _ in 0..worker_count {
            let next_partition = &next_partition;
            let generated_bytes = &generated_bytes;
            scope.spawn(move || {
                let mut bytes = 0;
                loop {
                    let partition = next_partition.fetch_add(1, Ordering::AcqRel);
                    if partition >= partitions {
                        break;
                    }
                    let directory = root.join(format!("src/partition-{partition:06}"));
                    fs::create_dir_all(&directory).expect("source partition must be created");
                    let start = partition * FILES_PER_PARTITION;
                    let end = (start + FILES_PER_PARTITION).min(source_files);
                    for index in start..end {
                        let extension =
                            EXTENSIONS[usize::try_from(index % EXTENSIONS.len() as u64).unwrap()];
                        let source = fixture(extension);
                        fs::write(
                            directory.join(format!("file-{index:09}.{extension}")),
                            source,
                        )
                        .expect("source fixture must be written");
                        bytes += u64::try_from(source.len()).unwrap();
                    }
                }
                generated_bytes.fetch_add(bytes, Ordering::AcqRel);
            });
        }
    });
    let mut bytes = generated_bytes.load(Ordering::Acquire);
    let vendor = root.join("vendor");
    fs::create_dir(&vendor).expect("ignored directory must be created");
    for index in 0..ignored_files {
        let source = b"ignored\n";
        fs::write(vendor.join(format!("ignored-{index:06}.txt")), source)
            .expect("ignored fixture must be written");
        bytes += u64::try_from(source.len()).unwrap();
    }
    fs::write(root.join(".gitignore"), "vendor/\n").expect("ignore fixture must be written");
    bytes + 8
}

fn generation_worker_count(source_files: u64, available_workers: usize) -> usize {
    let partitions = source_files.div_ceil(FILES_PER_PARTITION);
    usize::try_from(partitions.min(u64::try_from(available_workers.min(16)).unwrap()))
        .unwrap()
        .max(1)
}

fn fixture(extension: &str) -> &'static [u8] {
    match extension {
        "ts" => b"import { value } from './dep';\ninterface Config { ready: boolean }\nclass App extends Base { run() { return value(); } }\nrouter.get('/health', () => value());\n",
        "tsx" => b"export function App() { return <main>Ready</main>; }\n",
        "py" => b"from os import path\nclass App(object):\n    def run(self):\n        return path.exists('.')\n",
        "rs" => b"use std::fmt;\nstruct App;\nimpl App { fn run() { println!(\"ready\"); } }\n",
        "go" => b"package main\nimport \"fmt\"\ntype App struct{}\nfunc main() { fmt.Println(\"ready\") }\n",
        "java" => b"import java.util.List; class App { void run() { System.out.println(List.of()); } }\n",
        "kt" => b"fun main() { println(\"ready\") }\n",
        "cs" => b"using System; class App { void Run() { Console.WriteLine(\"ready\"); } }\n",
        "c" => b"#include <stdio.h>\nint main(void) { return puts(\"ready\"); }\n",
        "cpp" => b"#include <iostream>\nclass App { public: void run() { std::cout << \"ready\"; } };\n",
        "php" => b"<?php class App { public function run() { return true; } }\n",
        "rb" => b"class App\n  def run\n    puts 'ready'\n  end\nend\n",
        "swift" => b"import Foundation\nclass App { func run() { print(\"ready\") } }\n",
        "dart" => b"class App { void run() { print('ready'); } }\n",
        "sql" => b"CREATE TABLE users (id INTEGER PRIMARY KEY);\n",
        "html" => b"<!doctype html><html><body><main>Ready</main></body></html>\n",
        "css" => b".app { color: green; }\n",
        "sh" => b"#!/usr/bin/env bash\nprintf '%s\\n' ready\n",
        "ps1" => b"Write-Output 'ready'\n",
        "json" => br#"{"enabled":true}"#,
        "yaml" => b"enabled: true\n",
        "toml" => b"enabled = true\n",
        "xml" => b"<?xml version=\"1.0\"?><config enabled=\"true\"/>\n",
        _ => unreachable!("extension list and fixture map must match"),
    }
}

struct ResourceSampler {
    peak_cpu: Arc<AtomicU64>,
    peak_memory: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
    total_memory: u64,
}

impl ResourceSampler {
    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let peak_memory = Arc::new(AtomicU64::new(0));
        let peak_cpu = Arc::new(AtomicU64::new(0));
        let current_stop = Arc::clone(&stop);
        let current_memory = Arc::clone(&peak_memory);
        let current_cpu = Arc::clone(&peak_cpu);
        let total_memory = System::new_all().total_memory();
        let thread = thread::spawn(move || {
            let pid = sysinfo::get_current_pid().expect("benchmark process identifier must exist");
            let mut system = System::new_all();
            let logical_cpus = system.cpus().len().max(1) as f32;
            while !current_stop.load(Ordering::Acquire) {
                system.refresh_processes(ProcessesToUpdate::Some(&[pid]), false);
                if let Some(process) = system.process(pid) {
                    current_memory.fetch_max(process.memory(), Ordering::AcqRel);
                    current_cpu.fetch_max(
                        u64::from((process.cpu_usage() / logical_cpus).to_bits()),
                        Ordering::AcqRel,
                    );
                }
                thread::sleep(Duration::from_millis(200));
            }
        });
        Self {
            peak_cpu,
            peak_memory,
            stop,
            thread,
            total_memory,
        }
    }

    fn stop(self, corpus: &Path, generated_bytes: u64) -> ResourceResults {
        self.stop.store(true, Ordering::Release);
        self.thread.join().expect("resource sampler must stop");
        let peak_memory = self.peak_memory.load(Ordering::Acquire);
        let cpu_bits = u32::try_from(self.peak_cpu.load(Ordering::Acquire)).unwrap_or(0);
        let available_disk = Disks::new_with_refreshed_list()
            .iter()
            .filter(|disk| corpus.starts_with(disk.mount_point()))
            .max_by_key(|disk| disk.mount_point().components().count())
            .map(sysinfo::Disk::available_space);
        ResourceResults {
            available_disk_bytes_after: available_disk,
            generated_bytes,
            peak_cpu_percent: f32::from_bits(cpu_bits),
            peak_memory_bytes: peak_memory,
            peak_memory_percent: if self.total_memory == 0 {
                100.0
            } else {
                peak_memory as f64 * 100.0 / self.total_memory as f64
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_parallelism_is_bounded_by_partitions_and_available_workers() {
        assert_eq!(generation_worker_count(500_100, 8), 8);
        assert_eq!(generation_worker_count(1_001, 8), 2);
        assert_eq!(generation_worker_count(1, 8), 1);
        assert_eq!(generation_worker_count(500_100, 32), 16);
    }

    #[test]
    fn default_corpus_exceeds_the_release_threshold_and_covers_every_adapter() {
        assert!(DEFAULT_SOURCE_FILES + DEFAULT_IGNORED_FILES + 1 > 500_000);
        assert_eq!(EXTENSIONS.len(), 23);
        for extension in EXTENSIONS {
            assert!(
                workflow_code_intel::languages::adapter_for(Path::new(&format!(
                    "fixture.{extension}"
                )))
                .is_some()
            );
            assert!(!fixture(extension).is_empty());
        }
    }
}
