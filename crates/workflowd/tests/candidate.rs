use std::{fs, path::Path, process::Command};

use workflow_core::{CandidateFileKind, CandidateId, EvidenceId};
use workflowd::candidate::{CandidateFreezeError, freeze, promote};

struct Repository {
    _directory: tempfile::TempDir,
    base_revision: String,
    path: std::path::PathBuf,
}

impl Repository {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project");
        fs::create_dir(&path).unwrap();
        git(&path, ["init"]);
        git(&path, ["config", "user.email", "test@example.invalid"]);
        git(&path, ["config", "user.name", "Test User"]);
        git(&path, ["config", "core.hooksPath", ".git/hooks"]);
        git(&path, ["config", "core.autocrlf", "false"]);
        fs::write(path.join("package.json"), "{\"scripts\":{}}\n").unwrap();
        fs::write(path.join("bun.lock"), "lock\n").unwrap();
        fs::write(path.join("removed.txt"), "remove\n").unwrap();
        git(&path, ["add", "."]);
        git(&path, ["commit", "-m", "base"]);
        let base_revision = output(&path, ["rev-parse", "HEAD"]);
        Self {
            _directory: directory,
            base_revision,
            path,
        }
    }

    fn commit_candidate(&self) {
        fs::write(
            self.path.join("package.json"),
            "{\"scripts\":{\"test\":\"ok\"}}\n",
        )
        .unwrap();
        fs::remove_file(self.path.join("removed.txt")).unwrap();
        fs::create_dir(self.path.join("dist")).unwrap();
        fs::write(self.path.join("dist").join("app.js"), "production\n").unwrap();
        git(&self.path, ["add", "-A"]);
        git(&self.path, ["commit", "-m", "candidate"]);
    }
}

#[test]
fn freezes_exact_changes_with_stable_order_and_environment() {
    let repository = Repository::new();
    repository.commit_candidate();
    let candidate_id = CandidateId::new();
    let evidence_id = EvidenceId::new();
    let first = freeze(
        &repository.path,
        &repository.base_revision,
        candidate_id,
        vec![evidence_id],
    )
    .unwrap();
    let second = freeze(
        &repository.path,
        &repository.base_revision,
        candidate_id,
        vec![evidence_id],
    )
    .unwrap();

    assert_eq!(first, second);
    assert_eq!(first.manifest.files().len(), 3);
    assert!(
        first
            .manifest
            .files()
            .windows(2)
            .all(|pair| pair[0].path < pair[1].path)
    );
    assert!(
        first
            .manifest
            .files()
            .iter()
            .any(|file| file.kind == CandidateFileKind::Deleted && file.digest.is_none())
    );
    assert!(
        first
            .manifest
            .files()
            .iter()
            .any(|file| file.kind == CandidateFileKind::Generated)
    );
    assert_eq!(
        first.manifest.diff_digest(),
        workflow_core::ContentDigest::of(&first.exact_diff)
    );
    assert_eq!(
        first.manifest.base_revision(),
        Some(repository.base_revision.as_str())
    );
}

#[test]
fn material_changes_invalidate_the_candidate_and_dirty_state_fails_closed() {
    let repository = Repository::new();
    repository.commit_candidate();
    let candidate_id = CandidateId::new();
    let original = freeze(
        &repository.path,
        &repository.base_revision,
        candidate_id,
        Vec::new(),
    )
    .unwrap();
    fs::write(repository.path.join("package.json"), "{\"changed\":true}\n").unwrap();
    assert!(matches!(
        freeze(
            &repository.path,
            &repository.base_revision,
            candidate_id,
            Vec::new()
        ),
        Err(CandidateFreezeError::DirtyWorktree)
    ));
    git(&repository.path, ["add", "package.json"]);
    git(&repository.path, ["commit", "-m", "material change"]);
    let changed = freeze(
        &repository.path,
        &repository.base_revision,
        candidate_id,
        Vec::new(),
    )
    .unwrap();
    assert_ne!(original.manifest.digest(), changed.manifest.digest());
    assert_ne!(
        original.manifest.configuration_digest(),
        changed.manifest.configuration_digest()
    );
    assert_eq!(
        original.manifest.environment_digest(),
        changed.manifest.environment_digest()
    );
}

#[test]
fn approved_diff_promotes_idempotently_without_overwriting_unrelated_user_changes() {
    let source = Repository::new();
    let candidate_directory = tempfile::tempdir().unwrap();
    let candidate = candidate_directory.path().join("candidate");
    assert!(
        Command::new("git")
            .args(["clone", "--no-hardlinks"])
            .arg(&source.path)
            .arg(&candidate)
            .status()
            .unwrap()
            .success()
    );
    git(&candidate, ["config", "user.email", "test@example.invalid"]);
    git(&candidate, ["config", "user.name", "Test User"]);
    git(&candidate, ["config", "core.hooksPath", ".git/hooks"]);
    let hooks = candidate_directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let hooks = hooks.to_string_lossy().into_owned();
    git(&candidate, ["config", "core.hooksPath", hooks.as_str()]);
    git(&candidate, ["config", "core.autocrlf", "false"]);
    git(&candidate, ["reset", "--hard", "HEAD"]);
    fs::write(
        candidate.join("package.json"),
        "{\"scripts\":{\"test\":\"ok\"}}\n",
    )
    .unwrap();
    fs::write(candidate.join("binary.bin"), [0, 255, 13, 10]).unwrap();
    fs::remove_file(candidate.join("removed.txt")).unwrap();
    git(&candidate, ["add", "-A"]);
    git(&candidate, ["commit", "-m", "candidate"]);
    let frozen = freeze(
        &candidate,
        &source.base_revision,
        CandidateId::new(),
        Vec::new(),
    )
    .unwrap();
    fs::write(source.path.join("user-notes.txt"), "preserve\n").unwrap();

    let first = promote(
        &source.path,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .unwrap();
    let second = promote(
        &source.path,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .unwrap();
    assert_eq!(first, vec!["binary.bin", "package.json", "removed.txt"]);
    assert_eq!(second, first);
    assert_eq!(
        fs::read_to_string(source.path.join("package.json")).unwrap(),
        "{\"scripts\":{\"test\":\"ok\"}}\n"
    );
    assert_eq!(
        fs::read_to_string(source.path.join("user-notes.txt")).unwrap(),
        "preserve\n"
    );
    assert_eq!(
        fs::read(source.path.join("binary.bin")).unwrap(),
        [0, 255, 13, 10]
    );
    assert!(!source.path.join("removed.txt").exists());
}

#[test]
fn promotion_respects_repository_line_ending_filters() {
    let source = Repository::new();
    git(&source.path, ["config", "core.autocrlf", "true"]);
    fs::remove_file(source.path.join("package.json")).unwrap();
    git(&source.path, ["checkout", "--", "package.json"]);
    assert!(
        fs::read(source.path.join("package.json"))
            .unwrap()
            .windows(2)
            .any(|bytes| bytes == b"\r\n")
    );
    let candidate_directory = tempfile::tempdir().unwrap();
    let candidate = candidate_directory.path().join("candidate");
    assert!(
        Command::new("git")
            .args(["clone", "--no-hardlinks"])
            .arg(&source.path)
            .arg(&candidate)
            .status()
            .unwrap()
            .success()
    );
    git(&candidate, ["config", "user.email", "test@example.invalid"]);
    git(&candidate, ["config", "user.name", "Test User"]);
    git(&candidate, ["config", "core.hooksPath", ".git/hooks"]);
    git(&candidate, ["config", "core.hooksPath", ".git/hooks"]);
    git(&candidate, ["config", "core.autocrlf", "true"]);
    git(&candidate, ["reset", "--hard", "HEAD"]);
    fs::write(
        candidate.join("package.json"),
        "{\"scripts\":{\"test\":\"ok\"}}\r\n",
    )
    .unwrap();
    git(&candidate, ["add", "package.json"]);
    git(&candidate, ["commit", "-m", "candidate"]);
    let frozen = freeze(
        &candidate,
        &source.base_revision,
        CandidateId::new(),
        Vec::new(),
    )
    .unwrap();

    let promoted = promote(
        &source.path,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .unwrap();

    assert_eq!(promoted, vec!["package.json"]);
    assert_eq!(
        fs::read(source.path.join("package.json")).unwrap(),
        b"{\"scripts\":{\"test\":\"ok\"}}\n"
    );
}

#[test]
fn executable_mode_is_part_of_the_frozen_delivery_payload() {
    let source = Repository::new();
    let candidate_directory = tempfile::tempdir().unwrap();
    let candidate = candidate_directory.path().join("candidate");
    assert!(
        Command::new("git")
            .args(["clone", "--no-hardlinks"])
            .arg(&source.path)
            .arg(&candidate)
            .status()
            .unwrap()
            .success()
    );
    git(&candidate, ["config", "user.email", "test@example.invalid"]);
    git(&candidate, ["config", "user.name", "Test User"]);
    let hooks = candidate_directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let hooks = hooks.to_string_lossy().into_owned();
    git(&candidate, ["config", "core.hooksPath", hooks.as_str()]);
    git(&candidate, ["update-index", "--chmod=+x", "package.json"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let path = candidate.join("package.json");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
    git(&candidate, ["commit", "-m", "candidate mode"]);
    let frozen = freeze(
        &candidate,
        &source.base_revision,
        CandidateId::new(),
        Vec::new(),
    );

    #[cfg(windows)]
    assert!(matches!(
        frozen,
        Err(CandidateFreezeError::UnsupportedExecutableMode)
    ));

    #[cfg(unix)]
    let frozen = frozen.unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        assert_eq!(frozen.exact_files.len(), 1);
        assert!(frozen.exact_files[0].is_executable());

        promote(
            &source.path,
            &frozen.manifest,
            &frozen.exact_diff,
            &frozen.exact_files,
        )
        .unwrap();
        assert_ne!(
            fs::metadata(source.path.join("package.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }
}

#[test]
fn conflict_does_not_partially_promote_candidate_files() {
    let source = Repository::new();
    let candidate_directory = tempfile::tempdir().unwrap();
    let candidate = candidate_directory.path().join("candidate");
    assert!(
        Command::new("git")
            .args(["clone", "--no-hardlinks"])
            .arg(&source.path)
            .arg(&candidate)
            .status()
            .unwrap()
            .success()
    );
    git(&candidate, ["config", "user.email", "test@example.invalid"]);
    git(&candidate, ["config", "user.name", "Test User"]);
    let hooks = candidate_directory.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let hooks = hooks.to_string_lossy().into_owned();
    git(&candidate, ["config", "core.hooksPath", hooks.as_str()]);
    fs::write(candidate.join("package.json"), b"candidate\r\n").unwrap();
    fs::remove_file(candidate.join("removed.txt")).unwrap();
    fs::write(candidate.join("binary.bin"), [0, 255, 13, 10]).unwrap();
    git(&candidate, ["add", "-A"]);
    git(&candidate, ["commit", "-m", "candidate"]);
    let frozen = freeze(
        &candidate,
        &source.base_revision,
        CandidateId::new(),
        Vec::new(),
    )
    .unwrap();
    fs::write(source.path.join("package.json"), b"user change\n").unwrap();

    assert!(
        promote(
            &source.path,
            &frozen.manifest,
            &frozen.exact_diff,
            &frozen.exact_files,
        )
        .is_err()
    );
    assert_eq!(
        fs::read(source.path.join("package.json")).unwrap(),
        b"user change\n"
    );
    assert_eq!(
        fs::read(source.path.join("removed.txt")).unwrap(),
        b"remove\n"
    );
    assert!(!source.path.join("binary.bin").exists());
}

#[test]
fn non_overlapping_edit_in_modified_file_is_not_overwritten() {
    let source = Repository::new();
    fs::write(source.path.join("shared.txt"), b"first\nsecond\nthird\n").unwrap();
    git(&source.path, ["add", "shared.txt"]);
    git(&source.path, ["commit", "-m", "shared base"]);
    let base = output(&source.path, ["rev-parse", "HEAD"]);
    let candidate_directory = tempfile::tempdir().unwrap();
    let candidate = candidate_directory.path().join("candidate");
    assert!(
        Command::new("git")
            .args(["clone", "--no-hardlinks"])
            .arg(&source.path)
            .arg(&candidate)
            .status()
            .unwrap()
            .success()
    );
    git(&candidate, ["config", "user.email", "test@example.invalid"]);
    git(&candidate, ["config", "user.name", "Test User"]);
    git(&candidate, ["config", "core.hooksPath", ".git/hooks"]);
    fs::write(candidate.join("shared.txt"), b"candidate\nsecond\nthird\n").unwrap();
    git(&candidate, ["add", "shared.txt"]);
    git(&candidate, ["commit", "-m", "candidate"]);
    let frozen = freeze(&candidate, &base, CandidateId::new(), Vec::new()).unwrap();
    fs::write(source.path.join("shared.txt"), b"first\nsecond\nuser\n").unwrap();

    assert!(
        promote(
            &source.path,
            &frozen.manifest,
            &frozen.exact_diff,
            &frozen.exact_files,
        )
        .is_err()
    );
    assert_eq!(
        fs::read(source.path.join("shared.txt")).unwrap(),
        b"first\nsecond\nuser\n"
    );
}

#[test]
fn promotion_handles_file_directory_transitions() {
    let source = Repository::new();
    fs::write(source.path.join("shape"), b"file\n").unwrap();
    git(&source.path, ["add", "shape"]);
    git(&source.path, ["commit", "-m", "shape base"]);
    let base = output(&source.path, ["rev-parse", "HEAD"]);
    let candidate_directory = tempfile::tempdir().unwrap();
    let candidate = candidate_directory.path().join("candidate");
    assert!(
        Command::new("git")
            .args(["clone", "--no-hardlinks"])
            .arg(&source.path)
            .arg(&candidate)
            .status()
            .unwrap()
            .success()
    );
    git(&candidate, ["config", "user.email", "test@example.invalid"]);
    git(&candidate, ["config", "user.name", "Test User"]);
    git(&candidate, ["config", "core.hooksPath", ".git/hooks"]);
    fs::remove_file(candidate.join("shape")).unwrap();
    fs::create_dir(candidate.join("shape")).unwrap();
    fs::write(candidate.join("shape/child.txt"), b"child\n").unwrap();
    git(&candidate, ["add", "-A"]);
    git(&candidate, ["commit", "-m", "file to directory"]);
    let frozen = freeze(&candidate, &base, CandidateId::new(), Vec::new()).unwrap();
    promote(
        &source.path,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .unwrap();
    assert_eq!(
        fs::read(source.path.join("shape/child.txt")).unwrap(),
        b"child\n"
    );

    git(&source.path, ["add", "-A"]);
    git(&source.path, ["commit", "-m", "directory base"]);
    let base = output(&source.path, ["rev-parse", "HEAD"]);
    fs::remove_dir_all(candidate_directory.path().join("candidate")).unwrap();
    let candidate = candidate_directory.path().join("candidate");
    assert!(
        Command::new("git")
            .args(["clone", "--no-hardlinks"])
            .arg(&source.path)
            .arg(&candidate)
            .status()
            .unwrap()
            .success()
    );
    git(&candidate, ["config", "user.email", "test@example.invalid"]);
    git(&candidate, ["config", "user.name", "Test User"]);
    git(&candidate, ["config", "core.hooksPath", ".git/hooks"]);
    fs::remove_dir_all(candidate.join("shape")).unwrap();
    fs::write(candidate.join("shape"), b"file again\n").unwrap();
    git(&candidate, ["add", "-A"]);
    git(&candidate, ["commit", "-m", "directory to file"]);
    let frozen = freeze(&candidate, &base, CandidateId::new(), Vec::new()).unwrap();
    promote(
        &source.path,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .unwrap();
    assert_eq!(
        fs::read(source.path.join("shape")).unwrap(),
        b"file again\n"
    );
}

fn git<'a>(repository: &Path, arguments: impl IntoIterator<Item = &'a str>) {
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(arguments)
            .status()
            .unwrap()
            .success()
    );
}

fn output<'a>(repository: &Path, arguments: impl IntoIterator<Item = &'a str>) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
