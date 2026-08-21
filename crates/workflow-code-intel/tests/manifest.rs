use workflow_code_intel::{
    FileMetadata, InventoryEntry, Manifest, ManifestEntry, ResolvedFileChange, hash_file,
};

fn metadata(path: &std::path::Path) -> FileMetadata {
    FileMetadata::from_std(&std::fs::metadata(path).unwrap())
}

#[test]
fn unchanged_metadata_avoids_content_reads_when_trusted() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("main.rs");
    std::fs::write(&path, "fn main() {}\n").unwrap();
    let (file_metadata, content_hash) = hash_file(&path).unwrap();
    let manifest = Manifest::from_entries([ManifestEntry {
        content_hash,
        metadata: file_metadata,
        relative_path: "main.rs".to_owned(),
    }]);
    let plan = manifest.plan(
        [InventoryEntry {
            metadata: file_metadata,
            relative_path: "main.rs".to_owned(),
        }],
        true,
    );
    std::fs::remove_file(path).unwrap();
    let update = plan.resolve(temporary.path(), &manifest).unwrap();
    assert!(update.changes.is_empty());
}

#[test]
fn add_edit_delete_and_rename_reconcile_by_content_hash() {
    let temporary = tempfile::tempdir().unwrap();
    let old = temporary.path().join("old.rs");
    let edited = temporary.path().join("edited.rs");
    let deleted = temporary.path().join("deleted.rs");
    std::fs::write(&old, "same\n").unwrap();
    std::fs::write(&edited, "before\n").unwrap();
    std::fs::write(&deleted, "delete\n").unwrap();
    let prior = Manifest::from_entries([
        entry(&old, "old.rs"),
        entry(&edited, "edited.rs"),
        entry(&deleted, "deleted.rs"),
    ]);
    std::fs::rename(&old, temporary.path().join("new.rs")).unwrap();
    std::fs::write(&edited, "after and longer\n").unwrap();
    std::fs::remove_file(deleted).unwrap();
    std::fs::write(temporary.path().join("added.rs"), "added\n").unwrap();

    let inventory = ["added.rs", "edited.rs", "new.rs"].map(|relative_path| InventoryEntry {
        metadata: metadata(&temporary.path().join(relative_path)),
        relative_path: relative_path.to_owned(),
    });
    let update = prior
        .plan(inventory, true)
        .resolve(temporary.path(), &prior)
        .unwrap();
    assert_eq!(
        update.changes,
        vec![
            ResolvedFileChange::Added("added.rs".to_owned()),
            ResolvedFileChange::Modified("edited.rs".to_owned()),
            ResolvedFileChange::Renamed {
                from: "old.rs".to_owned(),
                to: "new.rs".to_owned(),
            },
            ResolvedFileChange::Deleted("deleted.rs".to_owned()),
        ]
    );
    assert_eq!(update.manifest.entries().len(), 3);
}

#[test]
fn streaming_hash_matches_sha256_and_rejects_directories() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("value.txt");
    std::fs::write(&path, "abc").unwrap();
    let (_, digest) = hash_file(&path).unwrap();
    assert_eq!(
        digest.to_string(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert!(hash_file(temporary.path()).is_err());
}

fn entry(path: &std::path::Path, relative_path: &str) -> ManifestEntry {
    let (metadata, content_hash) = hash_file(path).unwrap();
    ManifestEntry {
        content_hash,
        metadata,
        relative_path: relative_path.to_owned(),
    }
}
