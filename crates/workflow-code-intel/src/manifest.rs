use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use workflow_core::ContentDigest;

use crate::InventoryEntry;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileMetadata {
    pub length: u64,
    pub modified_unix_nanos: Option<u64>,
}

impl FileMetadata {
    #[must_use]
    pub fn from_std(metadata: &std::fs::Metadata) -> Self {
        let modified_unix_nanos = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_nanos()).ok());
        Self {
            length: metadata.len(),
            modified_unix_nanos,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManifestEntry {
    pub content_hash: ContentDigest,
    pub metadata: FileMetadata,
    pub relative_path: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Manifest {
    entries: BTreeMap<String, ManifestEntry>,
}

impl Manifest {
    #[must_use]
    pub fn from_entries(entries: impl IntoIterator<Item = ManifestEntry>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|entry| (entry.relative_path.clone(), entry))
                .collect(),
        }
    }

    #[must_use]
    pub fn entries(&self) -> &BTreeMap<String, ManifestEntry> {
        &self.entries
    }

    #[must_use]
    pub fn plan(
        &self,
        inventory: impl IntoIterator<Item = InventoryEntry>,
        trust_metadata: bool,
    ) -> ManifestPlan {
        let mut seen = BTreeSet::new();
        let mut changes = Vec::new();
        let mut unchanged = Vec::new();
        for entry in inventory {
            seen.insert(entry.relative_path.clone());
            match self.entries.get(&entry.relative_path) {
                Some(previous) if trust_metadata && previous.metadata == entry.metadata => {
                    unchanged.push(previous.clone());
                }
                Some(_) => changes.push(FileChange::HashRequired {
                    metadata: entry.metadata,
                    relative_path: entry.relative_path,
                }),
                None => changes.push(FileChange::Added {
                    metadata: entry.metadata,
                    relative_path: entry.relative_path,
                }),
            }
        }
        for relative_path in self.entries.keys().filter(|path| !seen.contains(*path)) {
            changes.push(FileChange::Deleted {
                relative_path: relative_path.clone(),
            });
        }
        ManifestPlan { changes, unchanged }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileChange {
    Added {
        metadata: FileMetadata,
        relative_path: String,
    },
    Deleted {
        relative_path: String,
    },
    HashRequired {
        metadata: FileMetadata,
        relative_path: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestPlan {
    pub changes: Vec<FileChange>,
    pub unchanged: Vec<ManifestEntry>,
}

impl ManifestPlan {
    pub fn resolve(self, root: &Path, prior: &Manifest) -> Result<ManifestUpdate, ManifestError> {
        let mut entries: BTreeMap<_, _> = self
            .unchanged
            .into_iter()
            .map(|entry| (entry.relative_path.clone(), entry))
            .collect();
        let mut deleted: BTreeMap<_, _> = self
            .changes
            .iter()
            .filter_map(|change| match change {
                FileChange::Deleted { relative_path } => prior
                    .entries
                    .get(relative_path)
                    .cloned()
                    .map(|entry| (relative_path.clone(), entry)),
                FileChange::Added { .. } | FileChange::HashRequired { .. } => None,
            })
            .collect();
        let mut resolved = Vec::new();
        for change in self.changes {
            let (metadata, relative_path, added) = match change {
                FileChange::Added {
                    metadata,
                    relative_path,
                } => (metadata, relative_path, true),
                FileChange::HashRequired {
                    metadata,
                    relative_path,
                } => (metadata, relative_path, false),
                FileChange::Deleted { .. } => continue,
            };
            let (observed, content_hash) = hash_file(&root.join(&relative_path))?;
            if observed != metadata {
                return Err(ManifestError::ChangedDuringRead);
            }
            let entry = ManifestEntry {
                content_hash,
                metadata,
                relative_path: relative_path.clone(),
            };
            if added {
                let renamed_from = deleted
                    .iter()
                    .find(|(_, previous)| previous.content_hash == content_hash)
                    .map(|(path, _)| path.clone());
                if let Some(from) = renamed_from {
                    deleted.remove(&from);
                    resolved.push(ResolvedFileChange::Renamed {
                        from,
                        to: relative_path.clone(),
                    });
                } else {
                    resolved.push(ResolvedFileChange::Added(relative_path.clone()));
                }
            } else if prior
                .entries
                .get(&relative_path)
                .is_some_and(|previous| previous.content_hash != content_hash)
            {
                resolved.push(ResolvedFileChange::Modified(relative_path.clone()));
            }
            entries.insert(relative_path, entry);
        }
        resolved.extend(deleted.keys().cloned().map(ResolvedFileChange::Deleted));
        Ok(ManifestUpdate {
            changes: resolved,
            manifest: Manifest { entries },
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolvedFileChange {
    Added(String),
    Deleted(String),
    Modified(String),
    Renamed { from: String, to: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestUpdate {
    pub changes: Vec<ResolvedFileChange>,
    pub manifest: Manifest,
}

#[derive(Debug)]
pub enum ManifestError {
    ChangedDuringRead,
    Io(std::io::Error),
    NotRegularFile,
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ChangedDuringRead => {
                formatter.write_str("file changed while it was being hashed")
            }
            Self::Io(error) => error.fmt(formatter),
            Self::NotRegularFile => formatter.write_str("manifest path is not a regular file"),
        }
    }
}

impl std::error::Error for ManifestError {}

pub fn hash_file(path: &Path) -> Result<(FileMetadata, ContentDigest), ManifestError> {
    let before = std::fs::symlink_metadata(path).map_err(ManifestError::Io)?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(ManifestError::NotRegularFile);
    }
    let mut file = File::open(path).map_err(ManifestError::Io)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(ManifestError::Io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let after = file.metadata().map_err(ManifestError::Io)?;
    let before = FileMetadata::from_std(&before);
    let after = FileMetadata::from_std(&after);
    if before != after {
        return Err(ManifestError::ChangedDuringRead);
    }
    Ok((after, ContentDigest::from_bytes(hasher.finalize().into())))
}
