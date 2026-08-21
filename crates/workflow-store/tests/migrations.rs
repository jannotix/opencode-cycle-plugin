use std::num::NonZeroUsize;

use rusqlite::Connection;
use tempfile::TempDir;
use workflow_store::{
    CURRENT_SCHEMA_VERSION, Store, StoreError, StoreMode, backup_existing_database,
};

fn store_path(temporary: &TempDir) -> std::path::PathBuf {
    temporary.path().join("state").join("workflow.db")
}

#[test]
fn creates_current_schema_with_wal_and_fts5() {
    let temporary = TempDir::new().unwrap();
    let mut store = Store::open(store_path(&temporary), NonZeroUsize::new(2).unwrap()).unwrap();
    assert_eq!(store.mode(), StoreMode::ReadWrite);
    let connection = store.writer().unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let journal: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    connection
        .execute_batch("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(content);")
        .unwrap();
    assert_eq!(version, CURRENT_SCHEMA_VERSION);
    assert_eq!(journal.to_ascii_lowercase(), "wal");
}

#[test]
fn future_schema_opens_in_read_only_safe_mode() {
    let temporary = TempDir::new().unwrap();
    let path = store_path(&temporary);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);

    let mut store = Store::open(&path, NonZeroUsize::new(1).unwrap()).unwrap();
    assert_eq!(store.mode(), StoreMode::SafeReadOnly { schema_version: 99 });
    assert!(matches!(store.writer(), Err(StoreError::ReadOnly)));
}

#[test]
fn backup_restores_a_known_good_database() {
    let temporary = TempDir::new().unwrap();
    let path = store_path(&temporary);
    let backup = temporary.path().join("backup.db");
    let mut store = Store::open(&path, NonZeroUsize::new(1).unwrap()).unwrap();
    store
        .writer()
        .unwrap()
        .execute("INSERT INTO workflows VALUES ('one', '{}', 'now')", [])
        .unwrap();
    store.backup_to(&backup).unwrap();
    store
        .writer()
        .unwrap()
        .execute("DELETE FROM workflows", [])
        .unwrap();

    store.restore_from(&backup).unwrap();
    let count: u32 = store
        .writer()
        .unwrap()
        .query_row("SELECT count(*) FROM workflows", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn standalone_backup_uses_sqlite_and_never_clobbers_an_existing_destination() {
    let temporary = TempDir::new().unwrap();
    let path = store_path(&temporary);
    let backup = temporary.path().join("backup.db");
    let mut store = Store::open(&path, NonZeroUsize::new(1).unwrap()).unwrap();
    store
        .writer()
        .unwrap()
        .execute("INSERT INTO workflows VALUES ('one', '{}', 'now')", [])
        .unwrap();
    drop(store);

    backup_existing_database(&path, &backup).unwrap();
    let backup_connection = Connection::open(&backup).unwrap();
    let count: u32 = backup_connection
        .query_row("SELECT count(*) FROM workflows", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    assert!(
        matches!(backup_existing_database(&path, &backup), Err(StoreError::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists)
    );
}

#[test]
fn read_connections_are_bounded_and_released() {
    let temporary = TempDir::new().unwrap();
    let store = Store::open(store_path(&temporary), NonZeroUsize::new(1).unwrap()).unwrap();
    let reader = store.open_reader().unwrap();
    assert!(matches!(store.open_reader(), Err(StoreError::ReaderLimit)));
    drop(reader);
    assert!(store.open_reader().is_ok());
}
