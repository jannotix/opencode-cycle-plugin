use workflow_code_intel::{GitChange, GitChangeKind, parse_name_status_z};

#[test]
fn parses_add_edit_delete_rename_and_branch_switch_output() {
    let input = b"M\0src/edit.rs\0A\0src/add.rs\0D\0src/delete.rs\0R100\0src/old.rs\0src/new.rs\0";
    assert_eq!(
        parse_name_status_z(input).unwrap(),
        vec![
            GitChange {
                kind: GitChangeKind::Modified,
                path: "src/edit.rs".to_owned(),
                previous_path: None,
            },
            GitChange {
                kind: GitChangeKind::Added,
                path: "src/add.rs".to_owned(),
                previous_path: None,
            },
            GitChange {
                kind: GitChangeKind::Deleted,
                path: "src/delete.rs".to_owned(),
                previous_path: None,
            },
            GitChange {
                kind: GitChangeKind::Renamed,
                path: "src/new.rs".to_owned(),
                previous_path: Some("src/old.rs".to_owned()),
            },
        ]
    );
}

#[test]
fn malformed_git_output_fails_instead_of_dropping_paths() {
    assert!(parse_name_status_z(b"R100\0only-one-path\0").is_err());
    assert!(parse_name_status_z(&[b'M', 0, 0xff, 0]).is_err());
}
