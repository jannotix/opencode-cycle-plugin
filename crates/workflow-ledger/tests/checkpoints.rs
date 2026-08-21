use workflow_core::{ContentDigest, WorkflowTimestamp};
use workflow_ledger::{Checkpoint, CheckpointKey, CheckpointVerification, load_or_create};

#[test]
fn checkpoint_verification_distinguishes_failure_modes() {
    let key = CheckpointKey::from_seed(&[7; 32]);
    let other = CheckpointKey::from_seed(&[8; 32]);
    let head = ContentDigest::of(b"head");
    let checkpoint = Checkpoint::sign(
        4,
        head,
        WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap(),
        &key,
    );

    assert_eq!(
        checkpoint.verify(Some(&key.verifying_key()), Some((4, head))),
        CheckpointVerification::Valid
    );
    assert_eq!(
        checkpoint.verify(None, Some((4, head))),
        CheckpointVerification::MissingKey
    );
    assert_eq!(
        checkpoint.verify(Some(&other.verifying_key()), Some((4, head))),
        CheckpointVerification::WrongKey
    );
    assert_eq!(
        checkpoint.verify(Some(&key.verifying_key()), Some((5, head))),
        CheckpointVerification::HeadMismatch
    );

    let mut tampered = checkpoint;
    tampered.signature[0] ^= 1;
    assert_eq!(
        tampered.verify(Some(&key.verifying_key()), Some((4, head))),
        CheckpointVerification::InvalidSignature
    );
}

#[test]
fn checkpoint_key_is_persistent_and_never_debugged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("checkpoint.key");
    let first = load_or_create(&path).unwrap();
    let public_key = first.verifying_key();
    drop(first);
    let second = load_or_create(&path).unwrap();
    assert_eq!(second.verifying_key(), public_key);
    assert_eq!(format!("{second:?}"), "CheckpointKey([REDACTED])");
}
