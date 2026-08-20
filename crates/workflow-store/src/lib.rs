mod arbitration;
mod architecture;
mod candidates;
mod constraints;
mod goals;
mod leases;
mod ledger;
mod migrations;
pub mod paths;
mod requests;
mod reviews;
mod tasks;
mod verification;
mod workflows;

pub use candidates::{CandidateFilePayload, StoredCandidate};
pub use goals::{GoalApplyResult, GoalPlanRecord};
pub use leases::LeaseAcquisition;
pub use paths::{DataPaths, PathError, Platform, ProjectIdentity};
pub use tasks::TaskApplyResult;
pub use workflows::WorkflowApplyResult;

use std::{
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};

pub const CURRENT_SCHEMA_VERSION: u32 = 17;

pub fn backup_existing_database(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<(), StoreError> {
    let source = source.as_ref();
    let destination = destination.as_ref();
    if destination.exists() {
        return Err(StoreError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "backup destination already exists",
        )));
    }
    let connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    backup_connection(&connection, destination)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreMode {
    ReadWrite,
    SafeReadOnly { schema_version: u32 },
}

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    ReadOnly,
    ReaderLimit,
    InvalidBackup,
    AggregateConflict,
    InvalidCandidatePayload,
    MissingCandidatePayload,
    DeliveryInProgress,
    IdempotencyConflict,
    InvalidIdempotencyKey,
    Serialization(serde_json::Error),
    Transition(workflow_core::TransitionError),
    Lease(workflow_core::LeaseError),
    LeaseNotFound,
    InvalidDigest(workflow_core::DigestParseError),
    Ledger(workflow_ledger::LedgerError),
    LedgerCheckpoint,
    IntegerRange,
    RequestDigestMismatch,
    Evidence(workflow_core::EvidenceValidationError),
    Review(workflow_core::ReviewValidationError),
    Goal(workflow_core::GoalError),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Sqlite(error) => error.fmt(formatter),
            Self::ReadOnly => formatter.write_str("store is in read-only safe mode"),
            Self::ReaderLimit => formatter.write_str("bounded read connection limit reached"),
            Self::InvalidBackup => formatter.write_str("backup failed SQLite integrity validation"),
            Self::AggregateConflict => {
                formatter.write_str("aggregate identifier belongs to a different owner")
            }
            Self::InvalidCandidatePayload => {
                formatter.write_str("candidate payload does not match its immutable manifest")
            }
            Self::MissingCandidatePayload => {
                formatter.write_str("legacy candidate has no byte-exact delivery payload")
            }
            Self::DeliveryInProgress => {
                formatter.write_str("workflow candidate delivery is in progress")
            }
            Self::IdempotencyConflict => {
                formatter.write_str("idempotency key was already used for another aggregate")
            }
            Self::InvalidIdempotencyKey => {
                formatter.write_str("idempotency key must contain 1 to 256 bytes")
            }
            Self::Serialization(error) => error.fmt(formatter),
            Self::Transition(error) => error.fmt(formatter),
            Self::Lease(error) => error.fmt(formatter),
            Self::LeaseNotFound => formatter.write_str("execution lease was not found"),
            Self::InvalidDigest(error) => error.fmt(formatter),
            Self::Ledger(error) => error.fmt(formatter),
            Self::LedgerCheckpoint => {
                formatter.write_str("ledger checkpoint does not verify against its chain entry")
            }
            Self::IntegerRange => formatter.write_str("integer is outside the supported range"),
            Self::RequestDigestMismatch => {
                formatter.write_str("architecture plan does not bind to the immutable request")
            }
            Self::Evidence(error) => error.fmt(formatter),
            Self::Review(error) => error.fmt(formatter),
            Self::Goal(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value)
    }
}

impl From<workflow_core::TransitionError> for StoreError {
    fn from(value: workflow_core::TransitionError) -> Self {
        Self::Transition(value)
    }
}

impl From<workflow_core::LeaseError> for StoreError {
    fn from(value: workflow_core::LeaseError) -> Self {
        Self::Lease(value)
    }
}

impl From<workflow_core::DigestParseError> for StoreError {
    fn from(value: workflow_core::DigestParseError) -> Self {
        Self::InvalidDigest(value)
    }
}

impl From<workflow_ledger::LedgerError> for StoreError {
    fn from(value: workflow_ledger::LedgerError) -> Self {
        Self::Ledger(value)
    }
}

impl From<workflow_core::GoalError> for StoreError {
    fn from(value: workflow_core::GoalError) -> Self {
        Self::Goal(value)
    }
}

pub struct Store {
    connection: Connection,
    mode: StoreMode,
    path: PathBuf,
    active_readers: Arc<AtomicUsize>,
    reader_limit: NonZeroUsize,
}

impl Store {
    pub fn open(path: impl AsRef<Path>, reader_limit: NonZeroUsize) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let existing_version = if path.exists() {
            let probe = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            schema_version(&probe)?
        } else {
            0
        };
        let (connection, mode) = if existing_version > CURRENT_SCHEMA_VERSION {
            (
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?,
                StoreMode::SafeReadOnly {
                    schema_version: existing_version,
                },
            )
        } else {
            let mut connection = Connection::open(&path)?;
            configure_connection(&connection)?;
            migrations::migrate(&mut connection, existing_version)?;
            (connection, StoreMode::ReadWrite)
        };
        connection.busy_timeout(Duration::from_secs(5))?;

        Ok(Self {
            connection,
            mode,
            path,
            active_readers: Arc::new(AtomicUsize::new(0)),
            reader_limit,
        })
    }

    #[must_use]
    pub const fn mode(&self) -> StoreMode {
        self.mode
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn writer(&mut self) -> Result<&mut Connection, StoreError> {
        match self.mode {
            StoreMode::ReadWrite => Ok(&mut self.connection),
            StoreMode::SafeReadOnly { .. } => Err(StoreError::ReadOnly),
        }
    }

    pub fn open_reader(&self) -> Result<ReadConnection, StoreError> {
        let acquired =
            self.active_readers
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                    (active < self.reader_limit.get()).then_some(active + 1)
                });
        if acquired.is_err() {
            return Err(StoreError::ReaderLimit);
        }
        match Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(connection) => {
                if let Err(error) = connection.busy_timeout(Duration::from_secs(5)) {
                    self.active_readers.fetch_sub(1, Ordering::AcqRel);
                    return Err(StoreError::Sqlite(error));
                }
                Ok(ReadConnection {
                    connection,
                    active: Arc::clone(&self.active_readers),
                })
            }
            Err(error) => {
                self.active_readers.fetch_sub(1, Ordering::AcqRel);
                Err(StoreError::Sqlite(error))
            }
        }
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<(), StoreError> {
        if destination.as_ref().exists() {
            std::fs::remove_file(destination.as_ref())?;
        }
        backup_connection(&self.connection, destination.as_ref())
    }

    pub fn restore_from(&mut self, source: impl AsRef<Path>) -> Result<(), StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_database(source.as_ref())?;
        self.connection.restore(
            rusqlite::MAIN_DB,
            source,
            None::<fn(rusqlite::backup::Progress)>,
        )?;
        Ok(())
    }
}

fn backup_connection(connection: &Connection, destination: &Path) -> Result<(), StoreError> {
    connection.backup(rusqlite::MAIN_DB, destination, None)?;
    validate_database(destination)
}

fn validate_idempotency_key(value: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 256 {
        Err(StoreError::InvalidIdempotencyKey)
    } else {
        Ok(())
    }
}

pub struct ReadConnection {
    connection: Connection,
    active: Arc<AtomicUsize>,
}

impl std::ops::Deref for ReadConnection {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

impl Drop for ReadConnection {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn configure_connection(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<u32, rusqlite::Error> {
    connection.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn validate_database(path: &Path) -> Result<(), StoreError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let result: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(StoreError::InvalidBackup)
    }
}
