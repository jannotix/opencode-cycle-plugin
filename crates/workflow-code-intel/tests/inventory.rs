use std::path::Path;

use workflow_code_intel::{IgnorePolicy, inventory};

#[test]
fn inventory_respects_nested_gitignore_defaults_and_user_policy() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    std::fs::create_dir_all(root.join("src/generated")).unwrap();
    std::fs::create_dir_all(root.join("target/debug")).unwrap();
    std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
    std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
    std::fs::write(root.join("src/.gitignore"), "ignored.rs\n").unwrap();
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(root.join("src/ignored.rs"), "ignored\n").unwrap();
    std::fs::write(root.join("src/generated/output.rs"), "generated\n").unwrap();
    std::fs::write(root.join("debug.log"), "ignored\n").unwrap();
    std::fs::write(root.join("target/debug/app"), "ignored\n").unwrap();
    std::fs::write(root.join(".github/workflows/ci.yml"), "name: ci\n").unwrap();

    let policy = IgnorePolicy::new(root, ["src/generated/**".to_owned()], 1_024).unwrap();
    let mut files = Vec::new();
    let stats = inventory(root, &policy, |entry| {
        files.push(entry.relative_path);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        files,
        vec![
            ".github/workflows/ci.yml",
            ".gitignore",
            "src/.gitignore",
            "src/main.rs",
        ]
    );
    assert_eq!(stats.files, 4);
}

#[test]
fn policy_processes_a_million_paths_as_a_stream() {
    let temporary = tempfile::tempdir().unwrap();
    let policy = IgnorePolicy::new(temporary.path(), [], 1024).unwrap();
    let count = (0..1_000_001_u64)
        .filter(|index| policy.permits(Path::new(&format!("src/file-{index}.rs")), false, 10))
        .count();
    assert_eq!(count, 1_000_001);
}

#[cfg(unix)]
#[test]
fn symlinks_are_not_followed_outside_the_project() {
    use std::os::unix::fs::symlink;

    let temporary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    symlink(outside.path(), temporary.path().join("outside")).unwrap();
    let policy = IgnorePolicy::new(temporary.path(), [], 1024).unwrap();
    let mut files = Vec::new();
    inventory(temporary.path(), &policy, |entry| {
        files.push(entry.relative_path);
        Ok(())
    })
    .unwrap();
    assert!(files.is_empty());
}
