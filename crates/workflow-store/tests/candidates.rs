use std::num::NonZeroUsize;

use workflow_core::{
    CandidateDigests, CandidateFile, CandidateFileKind, CandidateId, CandidateManifest,
    ContentDigest, WorkflowCommand, WorkflowId, WorkflowTimestamp,
};
use workflow_store::{CandidateFilePayload, Store, StoreError, StoredCandidate};

fn manifest(candidate_id: CandidateId, content: &[u8], exact_diff: &[u8]) -> CandidateManifest {
    let payload_digest = ContentDigest::of(
        &serde_json::to_vec(&[("src/lib.rs", ContentDigest::of(content).to_string(), false)])
            .unwrap(),
    );
    CandidateManifest::new(
        candidate_id,
        Some("base".to_owned()),
        vec![
            CandidateFile::new(
                "src/lib.rs",
                Some(ContentDigest::of(content)),
                CandidateFileKind::Modified,
            )
            .unwrap(),
        ],
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(exact_diff),
            environment: ContentDigest::of(b"environment"),
        },
        Vec::new(),
    )
    .unwrap()
    .with_delivery_payload_digest(Some(payload_digest))
}

#[test]
fn candidate_bytes_are_immutable_and_scoped_to_their_workflow() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "candidate-test-intake",
            WorkflowCommand::CompleteIntake,
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let candidate_id = CandidateId::new();
    let candidate = manifest(candidate_id, b"first", b"exact diff");
    let payload = vec![CandidateFilePayload::new("src/lib.rs", b"first".to_vec())];
    assert!(
        !store
            .save_candidate_once(
                workflow_id,
                &candidate,
                b"exact diff",
                &payload,
                WorkflowTimestamp::now()
            )
            .unwrap()
    );
    assert!(
        store
            .save_candidate_once(
                workflow_id,
                &candidate,
                b"exact diff",
                &payload,
                WorkflowTimestamp::now()
            )
            .unwrap()
    );
    assert_eq!(
        store.load_candidate(candidate_id).unwrap(),
        Some(StoredCandidate {
            exact_diff: b"exact diff".to_vec(),
            exact_files: Some(payload.clone()),
            manifest: candidate.clone(),
            workflow_id,
        })
    );
    assert!(matches!(
        store.save_candidate_once(
            workflow_id,
            &manifest(candidate_id, b"changed", b"changed diff"),
            b"changed diff",
            &[CandidateFilePayload::new("src/lib.rs", b"changed".to_vec())],
            WorkflowTimestamp::now()
        ),
        Err(StoreError::AggregateConflict)
    ));

    let mode_manifest = CandidateManifest::new(
        candidate_id,
        Some("base".to_owned()),
        vec![
            CandidateFile::new(
                "src/lib.rs",
                Some(ContentDigest::of(b"first")),
                CandidateFileKind::Modified,
            )
            .unwrap()
            .with_executable(true),
        ],
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(b"exact diff"),
            environment: ContentDigest::of(b"environment"),
        },
        Vec::new(),
    )
    .unwrap();
    let mode_manifest = mode_manifest.with_delivery_payload_digest(Some(ContentDigest::of(
        &serde_json::to_vec(&[("src/lib.rs", ContentDigest::of(b"first").to_string(), true)])
            .unwrap(),
    )));
    assert!(matches!(
        store.save_candidate_once(
            workflow_id,
            &mode_manifest,
            b"exact diff",
            &payload,
            WorkflowTimestamp::now()
        ),
        Err(StoreError::InvalidCandidatePayload)
    ));

    assert!(matches!(
        store.save_candidate_once(
            workflow_id,
            &candidate,
            b"exact diff",
            &[CandidateFilePayload::new(
                "src/lib.rs",
                b"different".to_vec()
            )],
            WorkflowTimestamp::now()
        ),
        Err(StoreError::InvalidCandidatePayload)
    ));

    assert!(matches!(
        store.save_candidate_once(
            workflow_id,
            &candidate,
            b"exact diff",
            &[CandidateFilePayload::with_executable(
                "src/lib.rs",
                b"first".to_vec(),
                true
            )],
            WorkflowTimestamp::now()
        ),
        Err(StoreError::InvalidCandidatePayload)
    ));

    let mut legacy_json = serde_json::to_value(&candidate).unwrap();
    legacy_json
        .as_object_mut()
        .unwrap()
        .remove("delivery_payload_digest");
    for file in legacy_json["files"].as_array_mut().unwrap() {
        file.as_object_mut().unwrap().remove("executable");
    }
    let legacy_manifest: CandidateManifest = serde_json::from_value(legacy_json.clone()).unwrap();
    let legacy_digest = legacy_manifest.digest();
    store
        .writer()
        .unwrap()
        .execute(
            "UPDATE workflow_candidates
             SET payload_complete = 0, manifest_json = ?2, manifest_digest = ?3
             WHERE candidate_id = ?1",
            rusqlite::params![
                candidate_id.to_string(),
                serde_json::to_string(&legacy_manifest).unwrap(),
                legacy_digest.to_string()
            ],
        )
        .unwrap();
    let legacy = store.load_candidate(candidate_id).unwrap().unwrap();
    assert_eq!(legacy.workflow_id, workflow_id);
    assert_eq!(legacy.manifest, legacy_manifest);
    assert_eq!(legacy.manifest.digest(), legacy_digest);
    assert_eq!(legacy.exact_diff, b"exact diff");
    assert_eq!(legacy.exact_files, None);
    assert!(matches!(
        legacy.require_exact_files(),
        Err(StoreError::MissingCandidatePayload)
    ));
}

#[test]
fn delivery_reservation_is_idempotent_and_blocks_other_mutations() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "reservation-intake",
            WorkflowCommand::CompleteIntake,
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let candidate_id = CandidateId::new();
    let digest = ContentDigest::of(b"candidate");
    let candidate = manifest(candidate_id, b"candidate", b"candidate diff");
    store
        .save_candidate_once(
            workflow_id,
            &candidate,
            b"candidate diff",
            &[CandidateFilePayload::new(
                "src/lib.rs",
                b"candidate".to_vec(),
            )],
            WorkflowTimestamp::now(),
        )
        .unwrap();
    assert!(
        !store
            .reserve_candidate_delivery(workflow_id, candidate_id, digest, WorkflowTimestamp::now())
            .unwrap()
    );
    assert!(
        store
            .reserve_candidate_delivery(workflow_id, candidate_id, digest, WorkflowTimestamp::now())
            .unwrap()
    );
    assert!(matches!(
        store.apply_workflow_command(
            workflow_id,
            "reservation-cancel",
            WorkflowCommand::Cancel,
            WorkflowTimestamp::now()
        ),
        Err(StoreError::DeliveryInProgress)
    ));
    drop(store);

    let mut reopened = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    assert!(reopened.workflow_delivery_reserved(workflow_id).unwrap());
    assert!(
        reopened
            .reserve_candidate_delivery(workflow_id, candidate_id, digest, WorkflowTimestamp::now())
            .unwrap()
    );
    let other_digest = ContentDigest::of(b"other candidate");
    assert!(matches!(
        reopened.bind_candidate_delivery_journal(
            workflow_id,
            candidate_id,
            other_digest,
            None,
            ContentDigest::of(b"journal")
        ),
        Err(StoreError::AggregateConflict)
    ));
    assert!(matches!(
        reopened.release_candidate_delivery(workflow_id, candidate_id, other_digest),
        Err(StoreError::AggregateConflict)
    ));
    assert!(reopened.workflow_delivery_reserved(workflow_id).unwrap());
}

#[test]
fn load_rejects_combined_candidate_payload_over_limit_before_blob_read() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let candidate_id = CandidateId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "overlimit-intake",
            WorkflowCommand::CompleteIntake,
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let candidate = manifest(candidate_id, b"candidate", b"candidate diff");
    store
        .save_candidate_once(
            workflow_id,
            &candidate,
            b"candidate diff",
            &[CandidateFilePayload::new(
                "src/lib.rs",
                b"candidate".to_vec(),
            )],
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let oversized_part = 65_i64 * 1024 * 1024;
    store
        .writer()
        .unwrap()
        .execute(
            "UPDATE workflow_candidates SET exact_diff = zeroblob(?2) WHERE candidate_id = ?1",
            rusqlite::params![candidate_id.to_string(), oversized_part],
        )
        .unwrap();
    store
        .writer()
        .unwrap()
        .execute(
            "UPDATE workflow_candidate_files SET content = zeroblob(?2) WHERE candidate_id = ?1",
            rusqlite::params![candidate_id.to_string(), oversized_part],
        )
        .unwrap();

    assert!(matches!(
        store.load_candidate(candidate_id),
        Err(StoreError::InvalidCandidatePayload)
    ));
}

#[test]
fn latest_candidate_for_workflow_is_selected_by_creation_order() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "latest-candidate-intake",
            WorkflowCommand::CompleteIntake,
            WorkflowTimestamp::parse("2026-08-15T10:00:00Z").unwrap(),
        )
        .unwrap();
    let first_id = CandidateId::new();
    let second_id = CandidateId::new();
    store
        .save_candidate_once(
            workflow_id,
            &manifest(first_id, b"first", b"first diff"),
            b"first diff",
            &[CandidateFilePayload::new("src/lib.rs", b"first".to_vec())],
            WorkflowTimestamp::parse("2026-08-15T10:00:01Z").unwrap(),
        )
        .unwrap();
    store
        .save_candidate_once(
            workflow_id,
            &manifest(second_id, b"second", b"second diff"),
            b"second diff",
            &[CandidateFilePayload::new("src/lib.rs", b"second".to_vec())],
            WorkflowTimestamp::parse("2026-08-15T10:00:02Z").unwrap(),
        )
        .unwrap();

    assert_eq!(
        store
            .load_latest_candidate_for_workflow(workflow_id)
            .unwrap()
            .unwrap()
            .manifest
            .candidate_id(),
        second_id
    );
}
