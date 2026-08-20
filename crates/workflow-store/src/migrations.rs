use rusqlite::{Connection, TransactionBehavior};

use crate::CURRENT_SCHEMA_VERSION;

const MIGRATIONS: &[(u32, &str)] = &[
    (1, include_str!("../migrations/0001_initial.sql")),
    (2, include_str!("../migrations/0002_leases.sql")),
    (3, include_str!("../migrations/0003_ledger.sql")),
    (4, include_str!("../migrations/0004_memory.sql")),
    (5, include_str!("../migrations/0005_code_intel.sql")),
    (6, include_str!("../migrations/0006_workflow_requests.sql")),
    (7, include_str!("../migrations/0007_architecture.sql")),
    (8, include_str!("../migrations/0008_constraints.sql")),
    (9, include_str!("../migrations/0009_candidates.sql")),
    (10, include_str!("../migrations/0010_verification.sql")),
    (11, include_str!("../migrations/0011_reviews.sql")),
    (12, include_str!("../migrations/0012_arbitration.sql")),
    (
        13,
        include_str!("../migrations/0013_architecture_versions.sql"),
    ),
    (14, include_str!("../migrations/0014_code_index_state.sql")),
    (15, include_str!("../migrations/0015_goals.sql")),
    (16, include_str!("../migrations/0016_candidate_files.sql")),
    (17, include_str!("../migrations/0017_evidence_attempts.sql")),
];

pub(crate) fn migrate(
    connection: &mut Connection,
    current_version: u32,
) -> Result<(), rusqlite::Error> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (version, sql) in MIGRATIONS {
        if *version > current_version {
            transaction.execute_batch(sql)?;
            transaction.pragma_update(None, "user_version", version)?;
        }
    }
    transaction.commit()?;
    debug_assert_eq!(CURRENT_SCHEMA_VERSION, MIGRATIONS.last().unwrap().0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    #[test]
    fn failed_migration_rolls_back_schema_and_version() {
        let mut connection = Connection::open_in_memory().unwrap();
        let transaction = connection.transaction().unwrap();
        let result = transaction.execute_batch(
            "CREATE TABLE durable(id INTEGER PRIMARY KEY); PRAGMA user_version = 1; INVALID SQL;",
        );
        assert!(result.is_err());
        drop(transaction);

        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let tables: u32 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'durable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 0);
        assert_eq!(tables, 0);
    }
}
