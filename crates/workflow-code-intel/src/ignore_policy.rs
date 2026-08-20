use std::{collections::BTreeSet, path::Path};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

#[derive(Debug)]
pub enum IgnorePolicyError {
    Pattern(ignore::Error),
}

impl std::fmt::Display for IgnorePolicyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pattern(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for IgnorePolicyError {}

#[derive(Clone)]
pub struct IgnorePolicy {
    excluded_directories: BTreeSet<String>,
    excludes: Gitignore,
    max_file_bytes: u64,
}

impl IgnorePolicy {
    pub fn new(
        root: &Path,
        extra_excludes: impl IntoIterator<Item = String>,
        max_file_bytes: u64,
    ) -> Result<Self, IgnorePolicyError> {
        let mut builder = GitignoreBuilder::new(root);
        for pattern in extra_excludes {
            builder
                .add_line(None, &pattern)
                .map_err(IgnorePolicyError::Pattern)?;
        }
        let excludes = builder.build().map_err(IgnorePolicyError::Pattern)?;
        Ok(Self {
            excluded_directories: [
                ".git",
                ".idea",
                ".next",
                ".venv",
                ".vscode",
                "build",
                "coverage",
                "dist",
                "node_modules",
                "target",
                "vendor",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            excludes,
            max_file_bytes,
        })
    }

    #[must_use]
    pub fn permits(&self, relative: &Path, is_directory: bool, size: u64) -> bool {
        if relative.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|name| self.excluded_directories.contains(name))
        }) {
            return false;
        }
        size <= self.max_file_bytes
            && !self
                .excludes
                .matched_path_or_any_parents(relative, is_directory)
                .is_ignore()
    }
}
