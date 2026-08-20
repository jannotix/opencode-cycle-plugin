use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    num::NonZeroUsize,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::sync_channel,
    },
    thread,
    time::{Duration, Instant},
};

use workflow_core::{ContentDigest, ProjectId, WorkflowTimestamp};

use crate::{
    FileMetadata, IgnorePolicy, InventoryEntry, InventoryError, InventoryStats, ManifestEntry,
    graph::{GraphPartition, GraphStore, GraphStoreError, PartitionId},
    inventory,
    languages::{adapter_for, extract},
    parser::ParseError,
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct IndexTimings {
    pub hashing: Duration,
    pub inventory: Duration,
    pub parsing: Duration,
    pub persistence: Duration,
    pub total: Duration,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct IndexReport {
    pub edges: u64,
    pub hashed_files: u64,
    pub inventory: InventoryStats,
    pub maximum_generation: u64,
    pub nodes: u64,
    pub parse_errors: u64,
    pub parsed_files: u64,
    pub persisted_partitions: u64,
    pub timings: IndexTimings,
}

#[derive(Debug)]
pub enum IndexError {
    Graph(GraphStoreError),
    Inventory(InventoryError),
    Io(std::io::Error),
    Parse(ParseError),
    SourceChanged(String),
}

impl std::fmt::Display for IndexError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Graph(error) => error.fmt(formatter),
            Self::Inventory(error) => error.fmt(formatter),
            Self::Io(error) => error.fmt(formatter),
            Self::Parse(error) => error.fmt(formatter),
            Self::SourceChanged(path) => write!(formatter, "source changed while indexing: {path}"),
        }
    }
}

impl std::error::Error for IndexError {}

impl From<GraphStoreError> for IndexError {
    fn from(value: GraphStoreError) -> Self {
        Self::Graph(value)
    }
}

impl From<InventoryError> for IndexError {
    fn from(value: InventoryError) -> Self {
        Self::Inventory(value)
    }
}

impl From<std::io::Error> for IndexError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<ParseError> for IndexError {
    fn from(value: ParseError) -> Self {
        Self::Parse(value)
    }
}

struct IndexedScope {
    hashing: Duration,
    manifest: Vec<ManifestEntry>,
    parse_errors: u64,
    parsed_files: u64,
    parsing: Duration,
    partition: GraphPartition,
}

pub fn index_project(
    root: &Path,
    policy: &IgnorePolicy,
    graph_store: &mut GraphStore,
    project_id: ProjectId,
    forced_paths: &BTreeSet<String>,
    worker_limit: NonZeroUsize,
) -> Result<IndexReport, IndexError> {
    let total_started = Instant::now();
    let inventory_started = Instant::now();
    let mut entries = Vec::new();
    let inventory_stats = inventory(root, policy, |entry| {
        entries.push(entry);
        Ok(())
    })?;
    let inventory_time = inventory_started.elapsed();
    let prior = graph_store.load_manifest(project_id)?;
    let mut scopes = BTreeMap::<String, Vec<InventoryEntry>>::new();
    for entry in entries {
        if adapter_for(Path::new(&entry.relative_path)).is_some() {
            scopes
                .entry(scope_of(&entry.relative_path).to_owned())
                .or_default()
                .push(entry);
        }
    }
    let current = scopes
        .values()
        .flatten()
        .map(|entry| (entry.relative_path.as_str(), entry.metadata))
        .collect::<BTreeMap<_, _>>();
    let mut affected = BTreeSet::new();
    for (path, metadata) in &current {
        if prior
            .entries()
            .get(*path)
            .is_none_or(|entry| entry.metadata != *metadata)
        {
            affected.insert(scope_of(path).to_owned());
        }
    }
    for path in prior.entries().keys() {
        if !current.contains_key(path.as_str()) {
            affected.insert(scope_of(path).to_owned());
        }
    }
    affected.extend(forced_paths.iter().map(|path| scope_of(path).to_owned()));
    if prior.entries().is_empty() {
        affected.extend(scopes.keys().cloned());
    }
    drop(current);
    let work = affected
        .iter()
        .cloned()
        .map(|scope| {
            let files = scopes.remove(&scope).unwrap_or_default();
            (scope, files)
        })
        .collect::<Vec<_>>();
    let worker_count = worker_limit.get().min(work.len().max(1));
    let next = Arc::new(AtomicUsize::new(0));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = sync_channel::<Result<IndexedScope, IndexError>>(worker_count * 2);
    let mut manifest_entries = Vec::new();
    let mut report = IndexReport {
        inventory: inventory_stats,
        timings: IndexTimings {
            inventory: inventory_time,
            ..IndexTimings::default()
        },
        ..IndexReport::default()
    };
    let batch = graph_store.partition_batch(WorkflowTimestamp::now())?;
    let worker_result = thread::scope(|thread_scope| {
        let work = &work;
        for _ in 0..worker_count {
            let sender = sender.clone();
            let next = Arc::clone(&next);
            let cancelled = Arc::clone(&cancelled);
            thread_scope.spawn(move || {
                while !cancelled.load(Ordering::Acquire) {
                    let index = next.fetch_add(1, Ordering::AcqRel);
                    let Some((scope, files)) = work.get(index) else {
                        break;
                    };
                    if sender
                        .send(index_scope(root, project_id, scope, files))
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
        drop(sender);
        for result in receiver {
            match result {
                Ok(indexed) => {
                    report.edges +=
                        u64::try_from(indexed.partition.edges.len()).unwrap_or(u64::MAX);
                    report.hashed_files += indexed.parsed_files;
                    report.timings.hashing += indexed.hashing;
                    report.nodes +=
                        u64::try_from(indexed.partition.nodes.len()).unwrap_or(u64::MAX);
                    report.parse_errors += indexed.parse_errors;
                    report.parsed_files += indexed.parsed_files;
                    report.timings.parsing += indexed.parsing;
                    let persist_started = Instant::now();
                    let generation = batch.replace_partition(&indexed.partition)?;
                    report.maximum_generation = report.maximum_generation.max(generation);
                    report.timings.persistence += persist_started.elapsed();
                    report.persisted_partitions += 1;
                    manifest_entries.extend(indexed.manifest);
                }
                Err(error) => {
                    cancelled.store(true, Ordering::Release);
                    return Err(error);
                }
            }
        }
        Ok::<(), IndexError>(())
    });
    worker_result?;
    let persist_started = Instant::now();
    batch.replace_manifest_scopes(project_id, &affected, &manifest_entries)?;
    batch.commit()?;
    report.timings.persistence += persist_started.elapsed();
    report.timings.total = total_started.elapsed();
    Ok(report)
}

fn index_scope(
    root: &Path,
    project_id: ProjectId,
    scope: &str,
    files: &[InventoryEntry],
) -> Result<IndexedScope, IndexError> {
    let mut hashing = Duration::ZERO;
    let mut parsing = Duration::ZERO;
    let mut partition = GraphPartition {
        edges: BTreeMap::new(),
        external_nodes: BTreeSet::new(),
        id: PartitionId::new(project_id, scope),
        nodes: BTreeMap::new(),
        project_id,
        scope: scope.to_owned(),
    };
    let mut manifest = Vec::with_capacity(files.len());
    let mut parse_errors = 0;
    for entry in files {
        let hash_started = Instant::now();
        let path = root.join(&entry.relative_path);
        let before = fs::symlink_metadata(&path)?;
        if !before.is_file() || before.file_type().is_symlink() {
            return Err(IndexError::SourceChanged(entry.relative_path.clone()));
        }
        let source = fs::read(&path)?;
        let after = fs::metadata(&path)?;
        if FileMetadata::from_std(&before) != entry.metadata
            || FileMetadata::from_std(&after) != entry.metadata
        {
            return Err(IndexError::SourceChanged(entry.relative_path.clone()));
        }
        let content_hash = ContentDigest::of(&source);
        hashing += hash_started.elapsed();
        let adapter = adapter_for(&path).expect("inventory work contains supported files only");
        let parse_started = Instant::now();
        let extraction = extract(&adapter, project_id, scope, &entry.relative_path, &source)?;
        parsing += parse_started.elapsed();
        parse_errors += u64::from(extraction.has_errors);
        partition.nodes.extend(extraction.partition.nodes);
        partition.edges.extend(extraction.partition.edges);
        partition
            .external_nodes
            .extend(extraction.partition.external_nodes);
        manifest.push(ManifestEntry {
            content_hash,
            metadata: entry.metadata,
            relative_path: entry.relative_path.clone(),
        });
    }
    Ok(IndexedScope {
        hashing,
        manifest,
        parse_errors,
        parsed_files: u64::try_from(files.len()).unwrap_or(u64::MAX),
        parsing,
        partition,
    })
}

fn scope_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("root", |(scope, _)| scope)
}
