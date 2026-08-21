use std::{collections::BTreeMap, path::PathBuf};

use tempfile::TempDir;
use workflow_store::{DataPaths, PathError, Platform};

fn environment(root: &std::path::Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "HOME".into(),
            root.join("home").to_string_lossy().into_owned(),
        ),
        (
            "LOCALAPPDATA".into(),
            root.join("local").to_string_lossy().into_owned(),
        ),
        (
            "XDG_DATA_HOME".into(),
            root.join("xdg").to_string_lossy().into_owned(),
        ),
    ])
}

#[test]
fn resolves_native_paths_for_every_certified_platform() {
    let temporary = TempDir::new().unwrap();
    let project = temporary.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let environment = environment(temporary.path());

    let windows = DataPaths::resolve(Platform::Windows, &environment, &project, &[]).unwrap();
    let macos = DataPaths::resolve(Platform::MacOs, &environment, &project, &[]).unwrap();
    let linux = DataPaths::resolve(Platform::Linux, &environment, &project, &[]).unwrap();

    assert!(windows.root.ends_with("local/OpenCode Cycle"));
    assert!(
        macos
            .root
            .ends_with("home/Library/Application Support/OpenCode Cycle")
    );
    assert!(linux.root.ends_with("xdg/opencode-cycle"));
}

#[test]
fn project_identity_is_stable_and_separates_projects() {
    let temporary = TempDir::new().unwrap();
    let first = temporary.path().join("first");
    let second = temporary.path().join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let environment = environment(temporary.path());

    let initial = DataPaths::resolve(Platform::Linux, &environment, &first, &[]).unwrap();
    let restarted = DataPaths::resolve(Platform::Linux, &environment, &first, &[]).unwrap();
    let other = DataPaths::resolve(Platform::Linux, &environment, &second, &[]).unwrap();

    assert_eq!(initial.project, restarted.project);
    assert_ne!(initial.project, other.project);
}

#[test]
fn rejects_state_path_inside_an_opencode_installation() {
    let temporary = TempDir::new().unwrap();
    let installation = temporary.path().join("installation");
    let project = temporary.path().join("project");
    std::fs::create_dir_all(&installation).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    let mut environment = environment(temporary.path());
    environment.insert(
        "LOCALAPPDATA".into(),
        installation.join("data").to_string_lossy().into_owned(),
    );

    let error = DataPaths::resolve(
        Platform::Windows,
        &environment,
        &project,
        &[PathBuf::from(&installation)],
    )
    .unwrap_err();
    assert!(matches!(error, PathError::InsideOpenCodeInstallation(_)));
}

#[test]
fn resolves_filesystem_aliases_before_installation_boundary_checks() {
    let temporary = TempDir::new().unwrap();
    let installation = temporary.path().join("installation");
    let project = temporary.path().join("project");
    let alias = temporary.path().join("alias");
    std::fs::create_dir_all(&installation).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    if create_directory_alias(&installation, &alias).is_err() {
        return;
    }
    let mut environment = environment(temporary.path());
    environment.insert(
        "LOCALAPPDATA".into(),
        alias.join("data").to_string_lossy().into_owned(),
    );

    assert!(matches!(
        DataPaths::resolve(Platform::Windows, &environment, &project, &[installation]),
        Err(PathError::InsideOpenCodeInstallation(_))
    ));
}

#[test]
fn rejects_relative_environment_paths() {
    let temporary = TempDir::new().unwrap();
    let project = temporary.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    let environment = BTreeMap::from([("XDG_DATA_HOME".into(), "relative".into())]);
    assert!(matches!(
        DataPaths::resolve(Platform::Linux, &environment, &project, &[]),
        Err(PathError::NotAbsolute(_))
    ));
}

#[cfg(unix)]
fn create_directory_alias(
    target: &std::path::Path,
    alias: &std::path::Path,
) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, alias)
}

#[cfg(windows)]
fn create_directory_alias(
    target: &std::path::Path,
    alias: &std::path::Path,
) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, alias)
}
