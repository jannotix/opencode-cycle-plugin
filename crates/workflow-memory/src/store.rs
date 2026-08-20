use std::{path::Path, time::Duration};

use rusqlite::{
    Connection, OptionalExtension, Transaction, params, params_from_iter, types::Value,
};
use workflow_core::{MemoryId, ProjectId, WorkflowTimestamp};

use crate::{ConfidenceClass, MemoryEntry, MemoryError, MemoryState};

pub struct MemoryStore {
    connection: Connection,
}

#[derive(Clone, Debug)]
pub struct MemorySearch {
    pub confidence: Option<ConfidenceClass>,
    pub from: Option<WorkflowTimestamp>,
    pub include_inactive: bool,
    pub limit: usize,
    pub project_id: ProjectId,
    pub scope: Option<String>,
    pub text: String,
    pub to: Option<WorkflowTimestamp>,
}

#[derive(Debug)]
pub enum MemoryStoreError {
    Domain(MemoryError),
    MissingSchema,
    NotFound,
    Serialization(serde_json::Error),
    Sqlite(rusqlite::Error),
}

impl std::fmt::Display for MemoryStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Domain(error) => error.fmt(formatter),
            Self::MissingSchema => formatter.write_str("memory schema is unavailable"),
            Self::NotFound => formatter.write_str("memory entry was not found"),
            Self::Serialization(error) => error.fmt(formatter),
            Self::Sqlite(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for MemoryStoreError {}

impl From<MemoryError> for MemoryStoreError {
    fn from(value: MemoryError) -> Self {
        Self::Domain(value)
    }
}

impl From<rusqlite::Error> for MemoryStoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<serde_json::Error> for MemoryStoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value)
    }
}

impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MemoryStoreError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "trusted_schema", "OFF")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version < 4 {
            return Err(MemoryStoreError::MissingSchema);
        }
        Ok(Self { connection })
    }

    pub fn insert(&mut self, entry: &MemoryEntry) -> Result<(), MemoryStoreError> {
        entry.validate()?;
        let transaction = self.connection.transaction()?;
        insert(&transaction, entry)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get(
        &self,
        project_id: ProjectId,
        id: MemoryId,
    ) -> Result<Option<MemoryEntry>, MemoryStoreError> {
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT entry_json FROM memory_entries WHERE project_id = ?1 AND id = ?2",
                params![project_id.to_string(), id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(MemoryStoreError::from)
    }

    pub fn search(&self, search: &MemorySearch) -> Result<Vec<MemoryEntry>, MemoryStoreError> {
        let terms = fts_terms(&search.text);
        let has_terms = !terms.is_empty();
        let mut sql = if has_terms {
            "SELECT e.entry_json FROM memory_fts f
             JOIN memory_entries e ON e.id = f.id
             WHERE memory_fts MATCH ? AND e.project_id = ?"
                .to_owned()
        } else {
            "SELECT e.entry_json FROM memory_entries e WHERE e.project_id = ?".to_owned()
        };
        let mut values = Vec::new();
        if has_terms {
            values.push(Value::Text(terms));
        }
        values.push(Value::Text(search.project_id.to_string()));
        if !search.include_inactive {
            sql.push_str(" AND e.state = 'current'");
        }
        if let Some(confidence) = search.confidence {
            sql.push_str(" AND e.confidence = ?");
            values.push(Value::Text(confidence_name(confidence).to_owned()));
        }
        if let Some(from) = search.from {
            sql.push_str(" AND e.created_at >= ?");
            values.push(Value::Text(from.to_string()));
        }
        if let Some(to) = search.to {
            sql.push_str(" AND e.created_at <= ?");
            values.push(Value::Text(to.to_string()));
        }
        if let Some(scope) = &search.scope {
            sql.push_str(
                " AND EXISTS (
                    SELECT 1 FROM memory_scopes s WHERE s.memory_id = e.id AND s.scope = ?
                )",
            );
            values.push(Value::Text(scope.clone()));
        }
        if has_terms {
            sql.push_str(" ORDER BY bm25(memory_fts), e.created_at DESC, e.id");
        } else {
            sql.push_str(" ORDER BY e.created_at DESC, e.id");
        }
        sql.push_str(" LIMIT ?");
        values.push(Value::Integer(
            i64::try_from(search.limit.clamp(1, 1_000)).expect("page limit fits in i64"),
        ));

        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            row.map_err(MemoryStoreError::from)
                .and_then(|json| serde_json::from_str(&json).map_err(MemoryStoreError::from))
        })
        .collect()
    }

    pub fn supersede(
        &mut self,
        project_id: ProjectId,
        current_id: MemoryId,
        replacement: &MemoryEntry,
    ) -> Result<(), MemoryStoreError> {
        replacement.validate()?;
        let transaction = self.connection.transaction()?;
        let current_json: String = transaction
            .query_row(
                "SELECT entry_json FROM memory_entries WHERE project_id = ?1 AND id = ?2",
                params![project_id.to_string(), current_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(MemoryStoreError::NotFound)?;
        let mut current: MemoryEntry = serde_json::from_str(&current_json)?;
        current.supersede(replacement)?;
        insert(&transaction, replacement)?;
        transaction.execute(
            "UPDATE memory_entries SET state = 'superseded', superseded_by = ?1, entry_json = ?2
             WHERE id = ?3 AND project_id = ?4",
            params![
                replacement.id.to_string(),
                serde_json::to_string(&current)?,
                current_id.to_string(),
                project_id.to_string(),
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn revoke(&mut self, project_id: ProjectId, id: MemoryId) -> Result<(), MemoryStoreError> {
        let Some(mut entry) = self.get(project_id, id)? else {
            return Err(MemoryStoreError::NotFound);
        };
        entry.revoke();
        self.connection.execute(
            "UPDATE memory_entries SET state = 'revoked', superseded_by = NULL, entry_json = ?1
             WHERE id = ?2 AND project_id = ?3",
            params![
                serde_json::to_string(&entry)?,
                id.to_string(),
                project_id.to_string()
            ],
        )?;
        Ok(())
    }
}

fn insert(transaction: &Transaction<'_>, entry: &MemoryEntry) -> Result<(), MemoryStoreError> {
    transaction.execute(
        "INSERT INTO memory_entries(
            id, project_id, confidence, kind, state, actor, title, summary, detail,
            created_at, superseded_by, entry_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            entry.id.to_string(),
            entry.project_id.to_string(),
            confidence_name(entry.confidence),
            json_name(entry.kind)?,
            state_name(entry.state),
            &entry.actor,
            &entry.title,
            &entry.summary,
            &entry.detail,
            entry.created_at.to_string(),
            entry.superseded_by.map(|id| id.to_string()),
            serde_json::to_string(entry)?,
        ],
    )?;
    transaction.execute(
        "INSERT INTO memory_fts(id, title, summary, detail) VALUES (?1, ?2, ?3, ?4)",
        params![
            entry.id.to_string(),
            &entry.title,
            &entry.summary,
            &entry.detail
        ],
    )?;
    for scope in &entry.scope {
        transaction.execute(
            "INSERT INTO memory_scopes(memory_id, scope) VALUES (?1, ?2)",
            params![entry.id.to_string(), scope],
        )?;
    }
    for event_id in &entry.provenance.source_event_ids {
        transaction.execute(
            "INSERT INTO memory_sources(memory_id, event_id) VALUES (?1, ?2)",
            params![entry.id.to_string(), event_id.to_string()],
        )?;
    }
    Ok(())
}

const fn confidence_name(value: ConfidenceClass) -> &'static str {
    match value {
        ConfidenceClass::Inferred => "inferred",
        ConfidenceClass::UserAsserted => "user_asserted",
        ConfidenceClass::Verified => "verified",
    }
}

const fn state_name(value: MemoryState) -> &'static str {
    match value {
        MemoryState::Current => "current",
        MemoryState::Revoked => "revoked",
        MemoryState::Superseded => "superseded",
    }
}

fn json_name(value: impl serde::Serialize) -> Result<String, serde_json::Error> {
    serde_json::to_string(&value).map(|value| value.trim_matches('"').to_owned())
}

fn fts_terms(value: &str) -> String {
    value
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}
