use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{CandidateId, ContentDigest, EvidenceId, digest::CanonicalHasher, path};

// Immutable protocol-v1 compatibility identifier for persisted candidate digests.
const LEGACY_PROTOCOL_V1_CANDIDATE_DOMAIN: &str = "opencode-workflow/candidate/v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct CandidateFile {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub executable: bool,
    pub path: String,
    pub digest: Option<ContentDigest>,
    pub kind: CandidateFileKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum CandidateFileKind {
    Added,
    Deleted,
    Generated,
    Modified,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct CandidateDigests {
    pub configuration: ContentDigest,
    pub dependency_state: ContentDigest,
    pub diff: ContentDigest,
    pub environment: ContentDigest,
}

impl CandidateFile {
    pub fn new(
        path: impl Into<String>,
        digest: Option<ContentDigest>,
        kind: CandidateFileKind,
    ) -> Result<Self, CandidateError> {
        let path = path.into();
        if !path::is_safe_relative(&path) {
            return Err(CandidateError::InvalidPath(path));
        }
        if matches!(kind, CandidateFileKind::Deleted) != digest.is_none() {
            return Err(CandidateError::InvalidDigestState(path));
        }
        Ok(Self {
            executable: false,
            path,
            digest,
            kind,
        })
    }

    #[must_use]
    pub const fn with_executable(mut self, executable: bool) -> Self {
        self.executable = executable;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CandidateError {
    InvalidPath(String),
    DuplicatePath(String),
    DuplicateEvidence(EvidenceId),
    InvalidDigestState(String),
}

impl std::fmt::Display for CandidateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPath(path) => write!(formatter, "invalid candidate path {path:?}"),
            Self::DuplicatePath(path) => write!(formatter, "duplicate candidate path {path:?}"),
            Self::DuplicateEvidence(id) => write!(formatter, "duplicate evidence {id}"),
            Self::InvalidDigestState(path) => {
                write!(
                    formatter,
                    "candidate file has an invalid digest state {path:?}"
                )
            }
        }
    }
}

impl std::error::Error for CandidateError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct CandidateManifest {
    candidate_id: CandidateId,
    base_revision: Option<String>,
    files: Vec<CandidateFile>,
    diff_digest: ContentDigest,
    dependency_state_digest: ContentDigest,
    configuration_digest: ContentDigest,
    environment_digest: ContentDigest,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery_payload_digest: Option<ContentDigest>,
    evidence_ids: Vec<EvidenceId>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateManifestUnchecked {
    candidate_id: CandidateId,
    base_revision: Option<String>,
    files: Vec<CandidateFile>,
    diff_digest: ContentDigest,
    dependency_state_digest: ContentDigest,
    configuration_digest: ContentDigest,
    environment_digest: ContentDigest,
    #[serde(default)]
    delivery_payload_digest: Option<ContentDigest>,
    evidence_ids: Vec<EvidenceId>,
}

impl TryFrom<CandidateManifestUnchecked> for CandidateManifest {
    type Error = CandidateError;

    fn try_from(value: CandidateManifestUnchecked) -> Result<Self, Self::Error> {
        Ok(Self::new(
            value.candidate_id,
            value.base_revision,
            value.files,
            CandidateDigests {
                configuration: value.configuration_digest,
                dependency_state: value.dependency_state_digest,
                diff: value.diff_digest,
                environment: value.environment_digest,
            },
            value.evidence_ids,
        )?
        .with_delivery_payload_digest(value.delivery_payload_digest))
    }
}

impl<'de> Deserialize<'de> for CandidateManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        CandidateManifestUnchecked::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

impl CandidateManifest {
    pub fn new(
        candidate_id: CandidateId,
        base_revision: Option<String>,
        mut files: Vec<CandidateFile>,
        digests: CandidateDigests,
        mut evidence_ids: Vec<EvidenceId>,
    ) -> Result<Self, CandidateError> {
        files.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        for pair in files.windows(2) {
            if pair[0].path == pair[1].path {
                return Err(CandidateError::DuplicatePath(pair[0].path.clone()));
            }
        }
        evidence_ids.sort_unstable();
        let mut seen = BTreeSet::new();
        for evidence_id in &evidence_ids {
            if !seen.insert(*evidence_id) {
                return Err(CandidateError::DuplicateEvidence(*evidence_id));
            }
        }
        Ok(Self {
            candidate_id,
            base_revision,
            files,
            diff_digest: digests.diff,
            dependency_state_digest: digests.dependency_state,
            configuration_digest: digests.configuration,
            environment_digest: digests.environment,
            delivery_payload_digest: None,
            evidence_ids,
        })
    }

    #[must_use]
    pub fn evidence_ids(&self) -> &[EvidenceId] {
        &self.evidence_ids
    }

    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        let mut hasher = CanonicalHasher::new(LEGACY_PROTOCOL_V1_CANDIDATE_DOMAIN);
        hasher.write_optional_str(self.base_revision.as_deref());
        hasher.write_u64(
            u64::try_from(self.files.len()).expect("supported collection lengths fit in u64"),
        );
        for file in &self.files {
            hasher.write_str(&file.path);
            hasher.write_bool(file.digest.is_some());
            if let Some(digest) = file.digest {
                hasher.write_digest(digest);
            }
            hasher.write_str(match file.kind {
                CandidateFileKind::Added => "added",
                CandidateFileKind::Deleted => "deleted",
                CandidateFileKind::Generated => "generated",
                CandidateFileKind::Modified => "modified",
            });
        }
        hasher.write_digest(self.diff_digest);
        hasher.write_digest(self.dependency_state_digest);
        hasher.write_digest(self.configuration_digest);
        hasher.write_digest(self.environment_digest);
        hasher.write_u64(
            u64::try_from(self.evidence_ids.len())
                .expect("supported collection lengths fit in u64"),
        );
        for evidence_id in &self.evidence_ids {
            hasher.write_bytes(evidence_id.as_uuid().as_bytes());
        }
        if let Some(delivery_payload_digest) = self.delivery_payload_digest {
            hasher.write_bool(true);
            hasher.write_digest(delivery_payload_digest);
        }
        hasher.finish()
    }

    #[must_use]
    pub const fn candidate_id(&self) -> CandidateId {
        self.candidate_id
    }

    #[must_use]
    pub fn files(&self) -> &[CandidateFile] {
        &self.files
    }

    #[must_use]
    pub fn base_revision(&self) -> Option<&str> {
        self.base_revision.as_deref()
    }

    #[must_use]
    pub const fn diff_digest(&self) -> ContentDigest {
        self.diff_digest
    }

    #[must_use]
    pub const fn dependency_state_digest(&self) -> ContentDigest {
        self.dependency_state_digest
    }

    #[must_use]
    pub const fn configuration_digest(&self) -> ContentDigest {
        self.configuration_digest
    }

    #[must_use]
    pub const fn environment_digest(&self) -> ContentDigest {
        self.environment_digest
    }

    #[must_use]
    pub const fn delivery_payload_digest(&self) -> Option<ContentDigest> {
        self.delivery_payload_digest
    }

    #[must_use]
    pub const fn with_delivery_payload_digest(mut self, digest: Option<ContentDigest>) -> Self {
        self.delivery_payload_digest = digest;
        self
    }
}
