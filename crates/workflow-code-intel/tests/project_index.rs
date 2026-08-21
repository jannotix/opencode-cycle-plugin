use std::{collections::BTreeSet, fs, num::NonZeroUsize};

use tempfile::TempDir;
use workflow_code_intel::{
    IgnorePolicy,
    graph::{GraphStore, PartitionId},
    index_project,
};
use workflow_core::ProjectId;
use workflow_store::Store;

#[test]
fn project_index_is_parallel_persistent_and_incremental() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    fs::create_dir_all(root.join("src/api")).unwrap();
    fs::create_dir_all(root.join("src/core")).unwrap();
    fs::write(root.join("src/api/a.ts"), "export const a = 1;\n").unwrap();
    fs::write(root.join("src/api/b.py"), "def b(): return 2\n").unwrap();
    fs::write(root.join("src/core/c.rs"), "fn c() {}\n").unwrap();
    let database = temporary.path().join("graph.db");
    drop(Store::open(&database, NonZeroUsize::new(1).unwrap()).unwrap());
    let mut graph = GraphStore::open(&database).unwrap();
    let project_id = ProjectId::new();
    let policy = IgnorePolicy::new(&root, [], 1024 * 1024).unwrap();

    let initial = index_project(
        &root,
        &policy,
        &mut graph,
        project_id,
        &BTreeSet::new(),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    assert_eq!(initial.parsed_files, 3);
    assert_eq!(initial.persisted_partitions, 2);
    let unchanged = index_project(
        &root,
        &policy,
        &mut graph,
        project_id,
        &BTreeSet::new(),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    assert_eq!(unchanged.parsed_files, 0);
    assert_eq!(unchanged.persisted_partitions, 0);

    fs::write(root.join("src/api/a.ts"), "export const a = 3;\n").unwrap();
    fs::rename(root.join("src/api/b.py"), root.join("src/api/bb.py")).unwrap();
    fs::remove_file(root.join("src/core/c.rs")).unwrap();
    let forced = [
        "src/api/a.ts",
        "src/api/b.py",
        "src/api/bb.py",
        "src/core/c.rs",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let incremental = index_project(
        &root,
        &policy,
        &mut graph,
        project_id,
        &forced,
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap();
    assert_eq!(incremental.parsed_files, 2);
    assert_eq!(incremental.persisted_partitions, 2);
    let api = graph
        .load_partition(PartitionId::new(project_id, "src/api"))
        .unwrap()
        .unwrap();
    assert!(
        api.nodes
            .values()
            .any(|node| node.source_path == "src/api/bb.py")
    );
    assert!(
        api.nodes
            .values()
            .all(|node| node.source_path != "src/api/b.py")
    );
    let core = graph
        .load_partition(PartitionId::new(project_id, "src/core"))
        .unwrap()
        .unwrap();
    assert!(core.nodes.is_empty());
    assert_eq!(
        graph
            .search_paths(project_id, &["bb".to_owned()], 10)
            .unwrap(),
        vec!["src/api/bb.py".to_owned()]
    );
    assert_eq!(
        graph
            .load_manifest(project_id)
            .unwrap()
            .entries()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec!["src/api/a.ts".to_owned(), "src/api/bb.py".to_owned()]
    );
    graph.reset_project(project_id).unwrap();
    assert!(
        graph
            .load_manifest(project_id)
            .unwrap()
            .entries()
            .is_empty()
    );
    assert!(
        graph
            .load_partition(PartitionId::new(project_id, "src/api"))
            .unwrap()
            .is_none()
    );
}
