use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

use workflow_core::{ProjectId, WorkflowId};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedWorktree {
    pub base_revision: String,
    pub path: PathBuf,
}

#[derive(Debug)]
pub enum WorktreeError {
    GitFailed(String),
    InvalidRepository,
    Io(std::io::Error),
    OutsideManagedRoot,
    UnsafeExistingTarget,
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GitFailed(message) => {
                write!(formatter, "Git worktree operation failed: {message}")
            }
            Self::InvalidRepository => formatter.write_str("project root is not a Git worktree"),
            Self::Io(error) => error.fmt(formatter),
            Self::OutsideManagedRoot => {
                formatter.write_str("worktree target is outside the managed root")
            }
            Self::UnsafeExistingTarget => {
                formatter.write_str("existing worktree target is not managed by this workflow")
            }
        }
    }
}

impl std::error::Error for WorktreeError {}

impl From<std::io::Error> for WorktreeError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub struct WorktreeManager {
    managed_root: PathBuf,
    repository: PathBuf,
}

impl WorktreeManager {
    pub fn new(repository: &Path, managed_root: &Path) -> Result<Self, WorktreeError> {
        let repository = repository.canonicalize()?;
        std::fs::create_dir_all(managed_root)?;
        let managed_root = managed_root.canonicalize()?;
        if repository == managed_root || managed_root.starts_with(&repository) {
            return Err(WorktreeError::OutsideManagedRoot);
        }
        let top_level = git(&repository, ["rev-parse", "--show-toplevel"])?;
        let discovered = PathBuf::from(output_text(&top_level)?).canonicalize()?;
        if discovered != repository {
            return Err(WorktreeError::InvalidRepository);
        }
        Ok(Self {
            managed_root,
            repository,
        })
    }

    pub fn create(
        &self,
        project_id: ProjectId,
        workflow_id: WorkflowId,
    ) -> Result<ManagedWorktree, WorktreeError> {
        let project_root = self.managed_root.join(project_id.to_string());
        std::fs::create_dir_all(&project_root)?;
        let project_root = project_root.canonicalize()?;
        if !project_root.starts_with(&self.managed_root) {
            return Err(WorktreeError::OutsideManagedRoot);
        }
        let target = project_root.join(workflow_id.to_string());
        if target.exists() {
            return self.existing(&target);
        }
        let revision = output_text(&git(&self.repository, ["rev-parse", "HEAD"])?)?;
        let output = Command::new("git")
            .arg("-C")
            .arg(command_path(&self.repository))
            .args(["worktree", "add", "--detach"])
            .arg(command_path(&target))
            .arg(&revision)
            .output()?;
        require_success(output)?;
        let managed = self.existing(&target)?;
        if managed.base_revision != revision {
            return Err(WorktreeError::UnsafeExistingTarget);
        }
        Ok(managed)
    }

    pub fn remove(&self, worktree: &ManagedWorktree) -> Result<(), WorktreeError> {
        let existing = self.existing(&worktree.path)?;
        if existing.base_revision != worktree.base_revision {
            return Err(WorktreeError::UnsafeExistingTarget);
        }
        let output = Command::new("git")
            .arg("-C")
            .arg(command_path(&self.repository))
            .args(["worktree", "remove", "--force"])
            .arg(command_path(&existing.path))
            .output()?;
        require_success(output)
    }

    fn existing(&self, target: &Path) -> Result<ManagedWorktree, WorktreeError> {
        let target = self.validate_existing_path(target)?;
        if !target.join(".git").is_file() {
            return Err(WorktreeError::UnsafeExistingTarget);
        }
        let revision = output_text(&git(&target, ["rev-parse", "HEAD"])?)?;
        Ok(ManagedWorktree {
            base_revision: revision,
            path: command_path(&target),
        })
    }

    fn validate_existing_path(&self, target: &Path) -> Result<PathBuf, WorktreeError> {
        let target = target.canonicalize()?;
        if target == self.managed_root || !target.starts_with(&self.managed_root) {
            return Err(WorktreeError::OutsideManagedRoot);
        }
        let relative = target
            .strip_prefix(&self.managed_root)
            .map_err(|_| WorktreeError::OutsideManagedRoot)?;
        if relative.components().count() != 2 {
            return Err(WorktreeError::OutsideManagedRoot);
        }
        Ok(target)
    }
}

fn git<'a>(
    directory: &Path,
    arguments: impl IntoIterator<Item = &'a str>,
) -> Result<Output, WorktreeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(command_path(directory))
        .args(arguments)
        .output()?;
    require_success_ref(&output)?;
    Ok(output)
}

fn command_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{value}"));
        }
        if let Some(value) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(value);
        }
    }
    path.to_owned()
}

fn require_success(output: Output) -> Result<(), WorktreeError> {
    require_success_ref(&output)
}

fn require_success_ref(output: &Output) -> Result<(), WorktreeError> {
    if output.status.success() {
        Ok(())
    } else {
        Err(WorktreeError::GitFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ))
    }
}

fn output_text(output: &Output) -> Result<String, WorktreeError> {
    let value = std::str::from_utf8(&output.stdout)
        .map_err(|_| WorktreeError::GitFailed("Git returned non-UTF-8 output".to_owned()))?
        .trim();
    if value.is_empty() {
        Err(WorktreeError::GitFailed(
            "Git returned empty output".to_owned(),
        ))
    } else {
        Ok(value.to_owned())
    }
}
