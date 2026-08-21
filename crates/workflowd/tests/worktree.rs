use std::{fs, process::Command};

use workflow_core::{ProjectId, WorkflowId};
use workflowd::worktree::{ManagedWorktree, WorktreeError, WorktreeManager};

fn repository() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let repository = directory.path().join("project");
    let hooks = directory.path().join("hooks");
    fs::create_dir(&repository).unwrap();
    fs::create_dir(&hooks).unwrap();
    for arguments in [
        vec!["init"],
        vec!["config", "user.email", "test@example.invalid"],
        vec!["config", "user.name", "Test User"],
        vec!["config", "core.autocrlf", "false"],
    ] {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .status()
                .unwrap()
                .success()
        );
    }
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["config", "core.hooksPath"])
            .arg(&hooks)
            .status()
            .unwrap()
            .success()
    );
    fs::write(repository.join("tracked.txt"), "base\n").unwrap();
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["add", "tracked.txt"])
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&repository)
            .args(["commit", "-m", "base"])
            .status()
            .unwrap()
            .success()
    );
    (directory, repository)
}

#[test]
fn creates_detached_isolated_worktrees_without_touching_dirty_source_files() {
    let (directory, repository) = repository();
    fs::write(repository.join("tracked.txt"), "user changes\n").unwrap();
    let manager = WorktreeManager::new(&repository, &directory.path().join("managed")).unwrap();
    let first = manager.create(ProjectId::new(), WorkflowId::new()).unwrap();
    let second = manager.create(ProjectId::new(), WorkflowId::new()).unwrap();

    assert_ne!(first.path, second.path);
    assert_eq!(
        fs::read_to_string(repository.join("tracked.txt")).unwrap(),
        "user changes\n"
    );
    assert_eq!(
        fs::read_to_string(first.path.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!([40, 64].contains(&first.base_revision.len()));
    assert!(
        first
            .base_revision
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    );
}

#[test]
fn existing_worktree_is_idempotent_and_cleanup_is_strictly_contained() {
    let (directory, repository) = repository();
    let manager = WorktreeManager::new(&repository, &directory.path().join("managed")).unwrap();
    let project_id = ProjectId::new();
    let workflow_id = WorkflowId::new();
    let worktree = manager.create(project_id, workflow_id).unwrap();
    assert_eq!(manager.create(project_id, workflow_id).unwrap(), worktree);

    let outside = ManagedWorktree {
        base_revision: worktree.base_revision.clone(),
        path: repository.clone(),
    };
    assert!(matches!(
        manager.remove(&outside),
        Err(WorktreeError::OutsideManagedRoot)
    ));

    let wrong_revision = ManagedWorktree {
        base_revision: "0".repeat(worktree.base_revision.len()),
        path: worktree.path.clone(),
    };
    assert!(matches!(
        manager.remove(&wrong_revision),
        Err(WorktreeError::UnsafeExistingTarget)
    ));
    manager.remove(&worktree).unwrap();
    assert!(!worktree.path.exists());
    assert!(repository.exists());
}

#[test]
fn rejects_non_root_repositories_and_managed_roots_inside_the_project() {
    let (directory, repository) = repository();
    let nested = repository.join("nested");
    fs::create_dir(&nested).unwrap();

    assert!(matches!(
        WorktreeManager::new(&nested, &directory.path().join("managed")),
        Err(WorktreeError::InvalidRepository)
    ));
    assert!(matches!(
        WorktreeManager::new(&repository, &repository.join("managed")),
        Err(WorktreeError::OutsideManagedRoot)
    ));
}
