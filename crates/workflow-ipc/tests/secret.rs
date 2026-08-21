use tempfile::TempDir;
use workflow_ipc::secret::{SecretError, load, load_or_create};

#[test]
fn credential_is_created_once_and_debug_output_is_redacted() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("runtime").join("ipc.secret");
    let created = load_or_create(&path).unwrap();
    let endpoint = created.endpoint_id();
    let loaded = load_or_create(&path).unwrap();
    assert_eq!(loaded.endpoint_id(), endpoint);
    assert_eq!(format!("{loaded:?}"), "IpcSecret([REDACTED])");
    assert_eq!(endpoint.len(), 32);
}

#[test]
fn malformed_credentials_fail_without_exposing_contents() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("bad.secret");
    std::fs::write(&path, b"a-secret-that-must-not-be-rendered").unwrap();
    let error = load(&path).unwrap_err();
    assert!(matches!(error, SecretError::InvalidLength));
    assert!(!error.to_string().contains("must-not-be-rendered"));
}

#[cfg(unix)]
#[test]
fn permissive_unix_credentials_are_rejected() {
    use std::os::unix::fs::PermissionsExt;
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("bad.secret");
    std::fs::write(&path, [1_u8; 32]).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(load(&path), Err(SecretError::InsecurePermissions)));
}
