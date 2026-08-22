use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    process::Command,
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
const GENERATION_WORKERS_PER_CPU: usize = 16;
const MAX_GENERATION_WORKERS: usize = 128;
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
    revision: String,
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
    let output = prepare_receipt_output(&options.output);
    let source = source_snapshot();
    let total_started = Instant::now();
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
        revision: source.revision.clone(),
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
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&results).expect("benchmark results must serialize")
    );
    publish_receipt_after_check(&output, serialized.as_bytes(), || source_unchanged(&source))
        .unwrap_or_else(|message| panic!("{message}"));
    if !passed {
        eprintln!(
            "500k codebase certification failed; inspect {}",
            output.display()
        );
        std::process::exit(1);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceSnapshot {
    revision: String,
}

fn source_snapshot() -> SourceSnapshot {
    let revision = git_output(&["rev-parse", "HEAD"]);
    let changes = git_output(&[
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
    ]);
    validate_source_snapshot(
        revision.trim(),
        &changes,
        std::env::var("CYCLE_RELEASE_REVISION").ok().as_deref(),
    )
    .unwrap_or_else(|message| panic!("{message}"))
}

fn source_unchanged(before: &SourceSnapshot) -> Result<(), String> {
    let revision = git_output(&["rev-parse", "HEAD"]);
    let changes = git_output(&[
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
    ]);
    validate_source_unchanged(
        before,
        revision.trim(),
        &changes,
        std::env::var("CYCLE_RELEASE_REVISION").ok().as_deref(),
    )
}

fn git_output(arguments: &[&str]) -> String {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .output()
        .expect("release source state must be resolved with git");
    assert!(
        output.status.success(),
        "release source state must be resolved with git"
    );
    String::from_utf8(output.stdout).expect("release source state must be UTF-8")
}

fn validate_source_snapshot(
    revision: &str,
    changes: &str,
    claimed_revision: Option<&str>,
) -> Result<SourceSnapshot, String> {
    if !valid_revision(revision) {
        return Err("release revision must be a full Git object ID".to_owned());
    }
    if claimed_revision.is_some_and(|claimed| claimed != revision) {
        return Err("claimed release revision does not match full HEAD".to_owned());
    }
    let disallowed = disallowed_source_changes(changes);
    if !disallowed.is_empty() {
        return Err(format!(
            "release source is dirty before the workload: {}",
            disallowed.join(", ")
        ));
    }
    Ok(SourceSnapshot {
        revision: revision.to_owned(),
    })
}

fn validate_source_unchanged(
    before: &SourceSnapshot,
    revision: &str,
    changes: &str,
    claimed_revision: Option<&str>,
) -> Result<(), String> {
    if revision != before.revision {
        return Err("release source revision changed during the workload".to_owned());
    }
    if claimed_revision.is_some_and(|claimed| claimed != revision) {
        return Err(
            "claimed release revision does not match full HEAD after the workload".to_owned(),
        );
    }
    let disallowed = disallowed_source_changes(changes);
    if !disallowed.is_empty() {
        return Err(format!(
            "release source is dirty after the workload: {}",
            disallowed.join(", ")
        ));
    }
    Ok(())
}

fn disallowed_source_changes(changes: &str) -> Vec<&str> {
    changes
        .lines()
        .filter(|line| {
            let Some(path) = line.strip_prefix("!! ") else {
                return !line.is_empty();
            };
            !allowed_ignored_path(&path.replace('\\', "/"))
        })
        .collect()
}

fn allowed_ignored_path(path: &str) -> bool {
    const ROOTS: &[&str] = &[
        ".bun/",
        ".superpowers/",
        ".worktrees/",
        "candidate/",
        "docs/specs/",
        "docs/superpowers/",
        "node_modules/",
        "packages/opencode-cycle/dist/",
        "packages/opencode-cycle/node_modules/",
        "packages/protocol-contracts/dist/",
        "packages/protocol-contracts/node_modules/",
        "target/",
    ];
    matches!(
        path,
        "packages/opencode-cycle/LICENSE" | "packages/opencode-cycle/NOTICE"
    ) || ROOTS
        .iter()
        .any(|root| path == *root || path.starts_with(root))
}

fn prepare_receipt_output(requested: &Path) -> PathBuf {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("release repository root must be canonical");
    let expected = repository
        .join("target")
        .join("certification")
        .join("codebase-500k.json");
    ensure_output_directory(&repository.join("target"));
    ensure_output_directory(&repository.join("target").join("certification"));
    let requested = resolve_receipt_output_path(requested);
    validate_receipt_output_policy(
        &repository,
        &requested,
        output_is_tracked(&repository, &expected),
        output_chain_has_link(&repository, &expected),
    )
    .unwrap_or_else(|message| panic!("{message}"));
    assert!(
        !expected.exists(),
        "release receipt output already exists before workload"
    );
    expected
}

fn resolve_receipt_output_path(requested: &Path) -> PathBuf {
    let requested_absolute = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        std::env::current_dir()
            .expect("release current directory must exist")
            .join(requested)
    };
    requested_absolute
        .file_name()
        .and_then(|name| {
            requested_absolute
                .parent()?
                .canonicalize()
                .ok()
                .map(|parent| parent.join(name))
        })
        .unwrap_or(requested_absolute)
}

fn validate_receipt_output_policy(
    repository: &Path,
    output: &Path,
    tracked: bool,
    linked: bool,
) -> Result<(), String> {
    let expected = repository
        .join("target")
        .join("certification")
        .join("codebase-500k.json");
    if output != expected {
        return Err(format!(
            "release receipt output must be exact: {}",
            expected.display()
        ));
    }
    if tracked {
        return Err("release receipt output must not be tracked".to_owned());
    }
    if linked {
        return Err(
            "release receipt output path must not contain links or reparse points".to_owned(),
        );
    }
    Ok(())
}

fn output_is_tracked(repository: &Path, output: &Path) -> bool {
    let relative = output
        .strip_prefix(repository)
        .expect("release output must be within repository");
    let status = Command::new("git")
        .args(["ls-files", "--error-unmatch", "--"])
        .arg(relative)
        .current_dir(repository)
        .status()
        .expect("release output tracking must be inspected");
    match status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => panic!("release output tracking inspection failed"),
    }
}

fn output_chain_has_link(repository: &Path, output: &Path) -> bool {
    for path in [
        repository.to_path_buf(),
        repository.join("target"),
        repository.join("target").join("certification"),
        output.to_path_buf(),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || metadata_is_reparse(&metadata)
                    || (path == output && path_link_count(&path, &metadata) != 1) =>
            {
                return true;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("release output metadata inspection failed: {error}"),
        }
    }
    false
}

fn ensure_output_directory(path: &Path) {
    if !path.exists() {
        fs::create_dir(path).expect("release output directory must be created directly");
    }
    let metadata = fs::symlink_metadata(path).expect("release output directory must be inspected");
    assert!(
        metadata.is_dir() && !metadata.file_type().is_symlink() && !metadata_is_reparse(&metadata),
        "release output directory must not be linked or reparse material"
    );
    assert_eq!(
        path.canonicalize()
            .expect("release output directory must canonicalize"),
        path,
        "release output directory must not be aliased"
    );
}

fn write_receipt_atomically(output: &Path, content: &[u8]) {
    let parent = output.parent().expect("release output must have a parent");
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .expect("release receipt temporary file must be private and local");
    temporary
        .write_all(content)
        .expect("release receipt temporary file must be written");
    temporary
        .as_file()
        .sync_all()
        .expect("release receipt temporary file must be synced");
    temporary
        .persist_noclobber(output)
        .unwrap_or_else(|error| panic!("release receipt must publish atomically: {error}"));
    let metadata = fs::symlink_metadata(output).expect("release receipt output must exist");
    assert!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && !metadata_is_reparse(&metadata)
            && path_link_count(output, &metadata) == 1,
        "release receipt output must be one real file"
    );
}

fn publish_receipt_after_check(
    output: &Path,
    content: &[u8],
    after_write: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    write_receipt_atomically(output, content);
    if let Err(message) = after_write() {
        fs::remove_file(output)
            .map_err(|error| format!("{message}; failed to remove invalid receipt: {error}"))?;
        return Err(message);
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn path_link_count(path: &Path, _metadata: &fs::Metadata) -> u64 {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .expect("release output hardlink inspection requires SystemRoot");
    let output = Command::new(system_root.join("System32").join("fsutil.exe"))
        .args(["hardlink", "list"])
        .arg(path)
        .output()
        .expect("release output hardlink inspection must run");
    assert!(
        output.status.success(),
        "release output hardlink inspection failed"
    );
    let count = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| {
            line.iter()
                .any(|byte| !matches!(byte, b' ' | b'\t' | b'\r'))
        })
        .count();
    assert!(count > 0, "release output hardlink inspection was empty");
    count as u64
}

#[cfg(unix)]
fn path_link_count(_path: &Path, metadata: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink()
}

#[cfg(not(any(unix, windows)))]
fn path_link_count(_path: &Path, _metadata: &fs::Metadata) -> u64 {
    0
}

fn valid_revision(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
    let available_workers = thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(1);
    let worker_count = generation_worker_count(source_files, available_workers);
    generate_corpus_with_workers(root, source_files, ignored_files, worker_count)
}

fn generate_corpus_with_workers(
    root: &Path,
    source_files: u64,
    ignored_files: u64,
    worker_count: usize,
) -> u64 {
    let partitions = source_files.div_ceil(FILES_PER_PARTITION);
    assert!(worker_count > 0, "generation worker count must be positive");
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
    let io_workers = available_workers
        .max(1)
        .saturating_mul(GENERATION_WORKERS_PER_CPU)
        .min(MAX_GENERATION_WORKERS);
    usize::try_from(partitions.min(u64::try_from(io_workers).unwrap()))
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
    fn release_revision_requires_a_full_lowercase_git_object_id() {
        assert!(valid_revision(&"a".repeat(40)));
        assert!(valid_revision(&"f".repeat(64)));
        assert!(!valid_revision(&"A".repeat(40)));
        assert!(!valid_revision("not-a-revision"));
    }

    #[test]
    fn release_receipt_rejects_dirty_source_before_and_after_the_workload() {
        let revision = "a".repeat(40);
        assert!(
            validate_source_snapshot(&revision, "?? untracked.txt\n", Some(&revision)).is_err()
        );
        let before = validate_source_snapshot(&revision, "", Some(&revision)).unwrap();
        assert!(
            validate_source_unchanged(&before, &revision, " M tracked.txt\n", Some(&revision))
                .is_err()
        );
    }

    #[test]
    fn release_receipt_rejects_claimed_and_post_workload_revision_drift() {
        let revision = "a".repeat(40);
        assert!(validate_source_snapshot(&revision, "", Some(&"b".repeat(40))).is_err());
        let before = validate_source_snapshot(&revision, "", Some(&revision)).unwrap();
        assert!(validate_source_unchanged(&before, &"c".repeat(40), "", Some(&revision)).is_err());
    }

    #[test]
    fn release_receipt_allows_only_explicit_ignored_generated_roots() {
        let revision = "a".repeat(40);
        assert!(
            validate_source_snapshot(&revision, "!! target/\n!! node_modules/\n", Some(&revision),)
                .is_ok()
        );
        assert!(validate_source_snapshot(&revision, "!! .env\n", Some(&revision)).is_err());
    }

    #[test]
    fn release_receipt_output_is_exact_untracked_json_without_links() {
        let root = Path::new("C:/repo");
        let exact = Path::new("C:/repo/target/certification/codebase-500k.json");
        assert!(validate_receipt_output_policy(root, exact, false, false).is_ok());
        assert!(
            validate_receipt_output_policy(root, Path::new("C:/repo/arbitrary.json"), false, false)
                .is_err()
        );
        assert!(validate_receipt_output_policy(root, exact, true, false).is_err());
        assert!(validate_receipt_output_policy(root, exact, false, true).is_err());

        let temporary = tempfile::tempdir().unwrap();
        let lane = temporary.path().join("target").join("certification");
        fs::create_dir_all(&lane).unwrap();
        let requested = lane.join("codebase-500k.json");
        let canonical = temporary
            .path()
            .canonicalize()
            .unwrap()
            .join("target")
            .join("certification")
            .join("codebase-500k.json");
        assert_eq!(resolve_receipt_output_path(&requested), canonical);
    }

    #[test]
    fn release_receipt_rejects_hardlinks_and_cleans_up_after_dirty_post_write_state() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.json");
        let linked = temporary.path().join("linked.json");
        fs::write(&source, "source").unwrap();
        fs::hard_link(&source, &linked).unwrap();
        assert_ne!(
            path_link_count(&linked, &fs::symlink_metadata(&linked).unwrap()),
            1
        );

        fs::remove_file(&linked).unwrap();
        let output = temporary.path().join("receipt.json");
        let result = publish_receipt_after_check(&output, b"{}\n", || {
            assert!(
                output.exists(),
                "receipt must exist during the final source check"
            );
            Err("release source is dirty after the receipt write".to_owned())
        });
        assert!(result.is_err());
        assert!(!output.exists());
    }

    #[test]
    fn generation_parallelism_is_bounded_by_partitions_and_available_workers() {
        assert_eq!(generation_worker_count(500_100, 8), 128);
        assert_eq!(generation_worker_count(1_001, 8), 2);
        assert_eq!(generation_worker_count(1, 8), 1);
        assert_eq!(generation_worker_count(500_100, 1), 16);
        assert_eq!(generation_worker_count(500_100, 32), 128);
    }

    #[test]
    fn parallel_generation_is_byte_identical_to_single_worker_generation() {
        fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
            let mut found = BTreeMap::new();
            let mut directories = vec![root.to_path_buf()];
            while let Some(directory) = directories.pop() {
                for entry in fs::read_dir(directory).unwrap() {
                    let entry = entry.unwrap();
                    let path = entry.path();
                    if path.is_dir() {
                        directories.push(path);
                    } else {
                        let relative = path
                            .strip_prefix(root)
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .replace('\\', "/");
                        found.insert(relative, fs::read(path).unwrap());
                    }
                }
            }
            found
        }

        let single = tempfile::tempdir().unwrap();
        let parallel = tempfile::tempdir().unwrap();
        let source_files = FILES_PER_PARTITION + 1;
        let ignored_files = 7;
        let single_bytes =
            generate_corpus_with_workers(single.path(), source_files, ignored_files, 1);
        let parallel_bytes =
            generate_corpus_with_workers(parallel.path(), source_files, ignored_files, 2);
        let single_files = files(single.path());
        let parallel_files = files(parallel.path());

        assert_eq!(single_bytes, parallel_bytes);
        assert_eq!(single_files, parallel_files);
        assert_eq!(
            single_files.len(),
            usize::try_from(source_files + ignored_files + 1).unwrap()
        );
        assert_eq!(single_files[".gitignore"], b"vendor/\n");
        let final_extension =
            EXTENSIONS[usize::try_from(FILES_PER_PARTITION % EXTENSIONS.len() as u64).unwrap()];
        assert_eq!(
            single_files[&format!("src/partition-000001/file-000001000.{final_extension}")],
            fixture(final_extension)
        );
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
