use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

use crate::{FileMetadata, IgnorePolicy};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InventoryEntry {
    pub metadata: FileMetadata,
    pub relative_path: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct InventoryStats {
    pub files: u64,
    pub skipped: u64,
}

#[derive(Debug)]
pub enum InventoryError {
    InvalidRoot,
    NonUtf8Path(PathBuf),
    Walk(ignore::Error),
}

impl std::fmt::Display for InventoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRoot => {
                formatter.write_str("inventory root must be an absolute directory")
            }
            Self::NonUtf8Path(path) => {
                write!(formatter, "path is not valid UTF-8: {}", path.display())
            }
            Self::Walk(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for InventoryError {}

pub fn inventory(
    root: &Path,
    policy: &IgnorePolicy,
    mut visitor: impl FnMut(InventoryEntry) -> Result<(), InventoryError>,
) -> Result<InventoryStats, InventoryError> {
    if !root.is_absolute() || !root.is_dir() {
        return Err(InventoryError::InvalidRoot);
    }
    let mut builder = WalkBuilder::new(root);
    let filter_root = root.to_path_buf();
    let filter_policy = policy.clone();
    builder
        .follow_links(false)
        .hidden(false)
        .require_git(false)
        .filter_entry(move |entry| {
            entry.path() == filter_root
                || entry
                    .path()
                    .strip_prefix(&filter_root)
                    .ok()
                    .is_some_and(|relative| filter_policy.permits(relative, true, 0))
        })
        .sort_by_file_path(|left, right| left.cmp(right));
    let mut stats = InventoryStats::default();
    for result in builder.build() {
        let entry = result.map_err(InventoryError::Walk)?;
        if entry.path() == root {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| InventoryError::InvalidRoot)?;
        let file_type = entry.file_type();
        if file_type.is_none_or(|kind| kind.is_symlink()) {
            stats.skipped += 1;
            continue;
        }
        if file_type.is_some_and(|kind| kind.is_dir()) {
            continue;
        }
        let metadata = entry.metadata().map_err(InventoryError::Walk)?;
        if !metadata.is_file() || !policy.permits(relative, false, metadata.len()) {
            stats.skipped += 1;
            continue;
        }
        let relative_path = relative
            .to_str()
            .ok_or_else(|| InventoryError::NonUtf8Path(relative.to_path_buf()))?
            .replace('\\', "/");
        visitor(InventoryEntry {
            metadata: FileMetadata::from_std(&metadata),
            relative_path,
        })?;
        stats.files += 1;
    }
    Ok(stats)
}
