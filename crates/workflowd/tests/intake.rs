use workflow_core::{ContentDigest, WorkflowTimestamp};
use workflowd::intake::{AttachmentMetadata, ImmutableIntake};

fn attachment() -> AttachmentMetadata {
    AttachmentMetadata::new(
        ContentDigest::of(b"attachment bytes"),
        Some("requirements.txt".to_owned()),
        "text/plain".to_owned(),
        16,
    )
    .unwrap()
}

#[test]
fn original_bytes_never_change_when_clarifications_are_appended() {
    let original = "Implement the API.\r\nKeep this exact line."
        .as_bytes()
        .to_vec();
    let mut intake = ImmutableIntake::capture(original.clone(), vec![attachment()]).unwrap();
    let before = intake.arbiter_bundle();

    intake
        .append_amendment(
            "The endpoint must also appear in the UI.".to_owned(),
            WorkflowTimestamp::from_unix_timestamp_nanos(42).unwrap(),
        )
        .unwrap();
    let after = intake.arbiter_bundle();

    assert_eq!(after.original_request.as_bytes(), original);
    assert_eq!(after.original_digest, before.original_digest);
    assert_ne!(after.request_digest, before.request_digest);
    assert_eq!(after.amendment_digests.len(), 1);
}

#[test]
fn serialization_cannot_replace_the_original_request_or_attachment_hashes() {
    let intake =
        ImmutableIntake::capture(b"Original request".to_vec(), vec![attachment()]).unwrap();
    let mut value = serde_json::to_value(&intake).unwrap();
    value["request"]["original_text"] = serde_json::json!("Architect interpretation");

    assert!(serde_json::from_value::<ImmutableIntake>(value).is_err());
}

#[test]
fn attachment_metadata_rejects_paths_control_characters_and_invalid_media_types() {
    let digest = ContentDigest::of(b"bytes");
    assert!(
        AttachmentMetadata::new(
            digest,
            Some("../secret.txt".to_owned()),
            "text/plain".to_owned(),
            5,
        )
        .is_err()
    );
    assert!(AttachmentMetadata::new(digest, None, "text/plain\n".to_owned(), 5).is_err());
}

#[test]
fn arbiter_bundle_contains_original_intake_not_an_architect_summary() {
    let intake = ImmutableIntake::capture(b"Build backend and frontend".to_vec(), vec![]).unwrap();
    let bundle = intake.arbiter_bundle();

    assert_eq!(bundle.original_request, "Build backend and frontend");
    assert_eq!(
        bundle.original_digest,
        ContentDigest::of(b"Build backend and frontend")
    );
}
