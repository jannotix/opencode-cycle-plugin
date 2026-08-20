use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};
use workflow_core::{
    CandidateFileKind, CandidateId, CandidateManifest, ContentDigest, WorkflowId, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode};

const MAX_CANDIDATE_PAYLOAD_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateFilePayload {
    content: Vec<u8>,
    executable: bool,
    path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredCandidate {
    pub exact_diff: Vec<u8>,
    pub exact_files: Option<Vec<CandidateFilePayload>>,
    pub manifest: CandidateManifest,
    pub workflow_id: WorkflowId,
}

impl StoredCandidate {
    pub fn require_exact_files(&self) -> Result<&[CandidateFilePayload], StoreError> {
        self.exact_files
            .as_deref()
            .ok_or(StoreError::MissingCandidatePayload)
    }
}

impl CandidateFilePayload {
    #[must_use]
    pub fn new(path: impl Into<String>, content: Vec<u8>) -> Self {
        Self {
            content,
            executable: false,
            path: path.into(),
        }
    }

    #[must_use]
    pub fn with_executable(path: impl Into<String>, content: Vec<u8>, executable: bool) -> Self {
        Self {
            content,
            executable,
            path: path.into(),
        }
    }

    #[must_use]
    pub fn content(&self) -> &[u8] {
        &self.content
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }

    #[must_use]
    pub const fn is_executable(&self) -> bool {
        self.executable
    }
}

impl Store {
    pub fn reserve_candidate_delivery(
        &mut self,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
        candidate_digest: ContentDigest,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let inserted = self.connection.execute(
            "INSERT INTO candidate_delivery_reservations
             (candidate_id, workflow_id, candidate_digest, started_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(candidate_id) DO NOTHING",
            params![
                candidate_id.to_string(),
                workflow_id.to_string(),
                candidate_digest.to_string(),
                timestamp.to_string()
            ],
        )?;
        if inserted == 1 {
            return Ok(false);
        }
        let current: (String, String) = self.connection.query_row(
            "SELECT workflow_id, candidate_digest FROM candidate_delivery_reservations
             WHERE candidate_id = ?1",
            [candidate_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if current == (workflow_id.to_string(), candidate_digest.to_string()) {
            Ok(true)
        } else {
            Err(StoreError::AggregateConflict)
        }
    }

    pub fn release_candidate_delivery(
        &mut self,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
        candidate_digest: ContentDigest,
    ) -> Result<(), StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let deleted = self.connection.execute(
            "DELETE FROM candidate_delivery_reservations
             WHERE candidate_id = ?1 AND workflow_id = ?2 AND candidate_digest = ?3",
            params![
                candidate_id.to_string(),
                workflow_id.to_string(),
                candidate_digest.to_string()
            ],
        )?;
        if deleted == 1 {
            Ok(())
        } else {
            Err(StoreError::AggregateConflict)
        }
    }

    pub fn bind_candidate_delivery_journal(
        &mut self,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
        candidate_digest: ContentDigest,
        expected_journal_digest: Option<ContentDigest>,
        journal_digest: ContentDigest,
    ) -> Result<(), StoreError> {
        let updated = self.connection.execute(
            "UPDATE candidate_delivery_reservations SET journal_digest = ?5
             WHERE candidate_id = ?1 AND workflow_id = ?2 AND candidate_digest = ?3
               AND ((?4 IS NULL AND journal_digest IS NULL) OR journal_digest = ?4)",
            params![
                candidate_id.to_string(),
                workflow_id.to_string(),
                candidate_digest.to_string(),
                expected_journal_digest.map(|digest| digest.to_string()),
                journal_digest.to_string()
            ],
        )?;
        if updated == 1 {
            Ok(())
        } else {
            Err(StoreError::AggregateConflict)
        }
    }

    pub fn workflow_delivery_reserved(&self, workflow_id: WorkflowId) -> Result<bool, StoreError> {
        self.connection
            .query_row(
                "SELECT EXISTS(
                SELECT 1 FROM candidate_delivery_reservations WHERE workflow_id = ?1
             )",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn candidate_delivery_journal_digest(
        &self,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
    ) -> Result<Option<ContentDigest>, StoreError> {
        let value: Option<Option<String>> = self
            .connection
            .query_row(
                "SELECT journal_digest FROM candidate_delivery_reservations
                 WHERE candidate_id = ?1 AND workflow_id = ?2",
                params![candidate_id.to_string(), workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        value
            .flatten()
            .map(|digest| digest.parse().map_err(StoreError::from))
            .transpose()
    }

    pub fn save_candidate_once(
        &mut self,
        workflow_id: WorkflowId,
        manifest: &CandidateManifest,
        exact_diff: &[u8],
        exact_files: &[CandidateFilePayload],
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        validate_diff(manifest, exact_diff)?;
        let exact_files = validated_payload(manifest, exact_diff.len(), exact_files)?;
        let manifest_json = serde_json::to_string(manifest)?;
        let transaction = self.connection.transaction()?;
        let current: Option<(String, String, Vec<u8>, i64)> = transaction
            .query_row(
                "SELECT workflow_id, manifest_json, exact_diff, payload_complete
                 FROM workflow_candidates WHERE candidate_id = ?1",
                [manifest.candidate_id().to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((owner, current_manifest, current_diff, payload_complete)) = current {
            if payload_complete != 1 {
                return Err(StoreError::MissingCandidatePayload);
            }
            let current_files = load_payload(&transaction, manifest.candidate_id())?;
            if owner != workflow_id.to_string()
                || current_manifest != manifest_json
                || current_diff != exact_diff
                || current_files != exact_files
            {
                return Err(StoreError::AggregateConflict);
            }
            return Ok(true);
        }
        transaction.execute(
            "INSERT INTO workflow_candidates
             (candidate_id, workflow_id, manifest_digest, manifest_json, exact_diff, created_at,
              payload_complete)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![
                manifest.candidate_id().to_string(),
                workflow_id.to_string(),
                manifest.digest().to_string(),
                manifest_json,
                exact_diff,
                timestamp.to_string()
            ],
        )?;
        for file in &exact_files {
            transaction.execute(
                "INSERT INTO workflow_candidate_files(candidate_id, path, content, executable)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    manifest.candidate_id().to_string(),
                    file.path(),
                    file.content(),
                    i64::from(file.is_executable())
                ],
            )?;
        }
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_candidate(
        &self,
        candidate_id: CandidateId,
    ) -> Result<Option<StoredCandidate>, StoreError> {
        let value: Option<(String, String, i64, i64)> = self
            .connection
            .query_row(
                "SELECT candidates.workflow_id, candidates.manifest_json,
                        length(candidates.exact_diff) + coalesce(sum(length(files.content)), 0),
                        candidates.payload_complete
                 FROM workflow_candidates candidates
                 LEFT JOIN workflow_candidate_files files
                   ON files.candidate_id = candidates.candidate_id
                 WHERE candidates.candidate_id = ?1
                 GROUP BY candidates.candidate_id",
                [candidate_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        value
            .map(
                |(workflow_id, manifest, exact_diff_bytes, payload_complete)| {
                    if usize::try_from(exact_diff_bytes)
                        .map_or(true, |bytes| bytes > MAX_CANDIDATE_PAYLOAD_BYTES)
                    {
                        return Err(StoreError::InvalidCandidatePayload);
                    }
                    let exact_diff: Vec<u8> = self.connection.query_row(
                        "SELECT exact_diff FROM workflow_candidates WHERE candidate_id = ?1",
                        [candidate_id.to_string()],
                        |row| row.get(0),
                    )?;
                    let manifest: CandidateManifest = serde_json::from_str(&manifest)?;
                    validate_diff(&manifest, &exact_diff)?;
                    let exact_files = if payload_complete == 1 {
                        Some(validated_payload(
                            &manifest,
                            exact_diff.len(),
                            &load_payload(&self.connection, candidate_id)?,
                        )?)
                    } else {
                        None
                    };
                    Ok(StoredCandidate {
                        workflow_id: workflow_id
                            .parse()
                            .map_err(|_| StoreError::AggregateConflict)?,
                        manifest,
                        exact_diff,
                        exact_files,
                    })
                },
            )
            .transpose()
    }

    pub fn load_latest_candidate_for_workflow(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Option<StoredCandidate>, StoreError> {
        let candidate_id = self
            .connection
            .query_row(
                "SELECT candidate_id FROM workflow_candidates
                 WHERE workflow_id = ?1
                 ORDER BY created_at DESC, candidate_id DESC
                 LIMIT 1",
                [workflow_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| value.parse().map_err(|_| StoreError::AggregateConflict))
            .transpose()?;
        candidate_id
            .map(|id| self.load_candidate(id))
            .transpose()
            .map(Option::flatten)
    }
}

fn validate_diff(manifest: &CandidateManifest, exact_diff: &[u8]) -> Result<(), StoreError> {
    if ContentDigest::of(exact_diff) == manifest.diff_digest() {
        Ok(())
    } else {
        Err(StoreError::InvalidCandidatePayload)
    }
}

fn validated_payload(
    manifest: &CandidateManifest,
    exact_diff_bytes: usize,
    exact_files: &[CandidateFilePayload],
) -> Result<Vec<CandidateFilePayload>, StoreError> {
    if exact_files
        .iter()
        .try_fold(exact_diff_bytes, |total, file| {
            total.checked_add(file.content().len())
        })
        .is_none_or(|total| total > MAX_CANDIDATE_PAYLOAD_BYTES)
    {
        return Err(StoreError::InvalidCandidatePayload);
    }
    let mut normalized = exact_files.to_vec();
    normalized.sort_unstable_by(|left, right| left.path.cmp(&right.path));
    let payload_digest = ContentDigest::of(&serde_json::to_vec(
        &normalized
            .iter()
            .map(|file| {
                (
                    file.path(),
                    ContentDigest::of(file.content()).to_string(),
                    file.is_executable(),
                )
            })
            .collect::<Vec<_>>(),
    )?);
    if manifest.delivery_payload_digest() != Some(payload_digest) {
        return Err(StoreError::InvalidCandidatePayload);
    }
    let expected: BTreeMap<_, _> = manifest
        .files()
        .iter()
        .filter_map(|file| {
            if matches!(file.kind, CandidateFileKind::Deleted) {
                None
            } else {
                Some((
                    file.path.as_str(),
                    (file.digest.expect("validated manifest"), file.executable),
                ))
            }
        })
        .collect();
    let mut observed = BTreeMap::new();
    for file in exact_files {
        if observed
            .insert(
                file.path(),
                (ContentDigest::of(file.content()), file.is_executable()),
            )
            .is_some()
        {
            return Err(StoreError::InvalidCandidatePayload);
        }
    }
    if observed != expected {
        return Err(StoreError::InvalidCandidatePayload);
    }
    Ok(normalized)
}

fn load_payload(
    connection: &Connection,
    candidate_id: CandidateId,
) -> Result<Vec<CandidateFilePayload>, StoreError> {
    let encoded_bytes: i64 = connection.query_row(
        "SELECT coalesce(sum(length(content)), 0) FROM workflow_candidate_files
         WHERE candidate_id = ?1",
        [candidate_id.to_string()],
        |row| row.get(0),
    )?;
    if usize::try_from(encoded_bytes).map_or(true, |bytes| bytes > MAX_CANDIDATE_PAYLOAD_BYTES) {
        return Err(StoreError::InvalidCandidatePayload);
    }
    let mut statement = connection.prepare(
        "SELECT path, content, executable FROM workflow_candidate_files
         WHERE candidate_id = ?1 ORDER BY path",
    )?;
    let rows = statement.query_map([candidate_id.to_string()], |row| {
        Ok(CandidateFilePayload::with_executable(
            row.get::<_, String>(0)?,
            row.get(1)?,
            row.get::<_, i64>(2)? == 1,
        ))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}
