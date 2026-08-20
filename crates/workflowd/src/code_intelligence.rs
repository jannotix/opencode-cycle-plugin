use std::{collections::BTreeSet, num::NonZeroUsize, path::Path, process::Command};

use serde_json::{Value, json};
use workflow_code_intel::{
    IgnorePolicy,
    graph::{GraphStore, PartitionId},
    index_project,
};
use workflow_core::{ContentDigest, ProjectId, RequestRecord, WorkflowTimestamp};

pub fn index_and_context(
    database: &Path,
    project_directory: &Path,
    project_id: ProjectId,
    request: &RequestRecord,
) -> Result<Value, String> {
    let root = std::fs::canonicalize(project_directory).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("project directory is not a directory".to_owned());
    }
    let repository_path = root.to_string_lossy().into_owned();
    let mut store = GraphStore::open(database).map_err(|error| error.to_string())?;
    if store
        .load_index_state(project_id)
        .map_err(|error| error.to_string())?
        .is_some_and(|(stored_path, _)| stored_path != repository_path)
    {
        store
            .reset_project(project_id)
            .map_err(|error| error.to_string())?;
    }
    let fingerprint_before = git_fingerprint(&root);
    let reusable = fingerprint_before.as_ref().is_some_and(|fingerprint| {
        store
            .load_index_state(project_id)
            .ok()
            .flatten()
            .is_some_and(|(stored_path, stored)| {
                stored_path == repository_path && stored == *fingerprint
            })
    });
    let report = if reusable {
        json!({
            "hashedFiles": 0,
            "inventoriedFiles": 0,
            "parsedFiles": 0,
            "persistedPartitions": 0,
            "reused": true,
        })
    } else {
        let logical_cpus = std::thread::available_parallelism().map_or(1, NonZeroUsize::get);
        let workers = NonZeroUsize::new((logical_cpus * 3 / 4).clamp(1, 16)).unwrap();
        let policy =
            IgnorePolicy::new(&root, [], 4 * 1024 * 1024).map_err(|error| error.to_string())?;
        let indexed = index_project(
            &root,
            &policy,
            &mut store,
            project_id,
            &BTreeSet::new(),
            workers,
        )
        .map_err(|error| error.to_string())?;
        let fingerprint_after = git_fingerprint(&root);
        if fingerprint_before.is_some() && fingerprint_before != fingerprint_after {
            return Err("project changed while code intelligence was indexing".to_owned());
        }
        if let Some(fingerprint) = fingerprint_after {
            store
                .save_index_state(
                    project_id,
                    &repository_path,
                    &fingerprint,
                    WorkflowTimestamp::now(),
                )
                .map_err(|error| error.to_string())?;
        }
        json!({
            "hashedFiles": indexed.hashed_files,
            "inventoriedFiles": indexed.inventory.files,
            "parsedFiles": indexed.parsed_files,
            "persistedPartitions": indexed.persisted_partitions,
            "reused": false,
            "timingsMillis": {
                "hashing": indexed.timings.hashing.as_millis(),
                "inventory": indexed.timings.inventory.as_millis(),
                "parsing": indexed.timings.parsing.as_millis(),
                "persistence": indexed.timings.persistence.as_millis(),
                "total": indexed.timings.total.as_millis(),
            },
            "workers": workers.get(),
        })
    };
    let terms = search_terms(request.original_text());
    let paths = store
        .search_paths(project_id, &terms, 128)
        .map_err(|error| error.to_string())?;
    let mut scopes = paths
        .iter()
        .map(|path| {
            path.rsplit_once('/')
                .map_or("root", |(scope, _)| scope)
                .to_owned()
        })
        .collect::<BTreeSet<_>>();
    if scopes.is_empty() {
        scopes.extend(
            store
                .project_scopes(project_id, 20)
                .map_err(|error| error.to_string())?,
        );
    }
    let scopes = scopes.into_iter().take(20).collect::<Vec<_>>();
    let matched_paths = paths.iter().collect::<BTreeSet<_>>();
    let mut nodes = Vec::new();
    for scope in &scopes {
        let Some(partition) = store
            .load_partition(PartitionId::new(project_id, scope))
            .map_err(|error| error.to_string())?
        else {
            continue;
        };
        let mut partition_nodes = partition.nodes.values().collect::<Vec<_>>();
        partition_nodes.sort_by_key(|node| !matched_paths.contains(&node.source_path));
        for node in partition_nodes {
            nodes.push(json!({
                "kind": node.kind,
                "name": bounded(&node.name, 512),
                "qualifiedName": bounded(&node.qualified_name, 1_024),
                "sourcePath": bounded(&node.source_path, 1_024),
            }));
            if nodes.len() == 200 {
                break;
            }
        }
        if nodes.len() == 200 {
            break;
        }
    }
    Ok(json!({
        "context": {
            "nodes": nodes,
            "paths": paths.iter().map(|path| bounded(path, 1_024)).collect::<Vec<_>>(),
            "scopes": scopes,
            "truncated": nodes.len() == 200,
        },
        "index": report,
    }))
}

fn bounded(value: &str, maximum_chars: usize) -> String {
    value.chars().take(maximum_chars).collect()
}

fn git_fingerprint(root: &Path) -> Option<String> {
    let head = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .ok()?;
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .ok()?;
    if !head.status.success() || !status.status.success() {
        return None;
    }
    let mut state = head.stdout;
    state.extend_from_slice(&status.stdout);
    Some(ContentDigest::of(&state).to_string())
}

fn search_terms(request: &str) -> Vec<String> {
    request
        .split(|character: char| {
            !character.is_alphanumeric() && character != '_' && character != '-'
        })
        .map(str::to_ascii_lowercase)
        .filter(|term| term.len() >= 3 && !is_stop_word(term))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(8)
        .collect()
}

fn is_stop_word(term: &str) -> bool {
    matches!(
        term,
        "add"
            | "and"
            | "build"
            | "change"
            | "create"
            | "for"
            | "from"
            | "implement"
            | "nel"
            | "per"
            | "the"
            | "this"
            | "update"
            | "with"
    )
}
