use std::collections::BTreeSet;
use std::str::FromStr;

use workflow_core::{
    ArbiterDecision, ArbiterVerdict, ArbitrationReceipt, CandidateDigests, CandidateFile,
    CandidateFileKind, CandidateId, CandidateManifest, ContentDigest, EvidenceId, EvidenceKind,
    EvidenceRecord, EvidenceStatus, EvidenceValidationError, Finding, FindingSeverity, ReceiptId,
    RepairTarget, RequestAmendment, RequestRecord, RequirementDecision, RequirementStatus,
    VerdictValidationError, WorkflowId, WorkflowTimestamp,
};

fn timestamp(value: &str) -> WorkflowTimestamp {
    WorkflowTimestamp::parse(value).unwrap()
}

fn candidate_file(path: &str, content: &[u8]) -> CandidateFile {
    CandidateFile::new(
        path,
        Some(ContentDigest::of(content)),
        CandidateFileKind::Modified,
    )
    .unwrap()
}

fn candidate_manifest(
    candidate_id: workflow_core::CandidateId,
    base_revision: Option<String>,
    files: Vec<CandidateFile>,
    evidence_ids: Vec<EvidenceId>,
) -> CandidateManifest {
    CandidateManifest::new(
        candidate_id,
        base_revision,
        files,
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(b"diff"),
            environment: ContentDigest::of(b"environment"),
        },
        evidence_ids,
    )
    .unwrap()
}

#[test]
fn original_request_and_amendments_hash_deterministically() {
    let attachment_a = ContentDigest::of(b"attachment-a");
    let attachment_b = ContentDigest::of(b"attachment-b");
    let mut first = RequestRecord::new(
        "  Preserve this exact request.\n".to_owned(),
        vec![attachment_b, attachment_a],
    );
    first
        .append_amendment(
            "Add the approved constraint.".to_owned(),
            timestamp("2026-08-12T09:00:00Z"),
        )
        .unwrap();
    let mut second = RequestRecord::new(
        "  Preserve this exact request.\n".to_owned(),
        vec![attachment_a, attachment_b],
    );
    second
        .append_amendment(
            "Add the approved constraint.".to_owned(),
            timestamp("2026-08-12T09:00:00Z"),
        )
        .unwrap();

    assert_eq!(first.original_text(), "  Preserve this exact request.\n");
    assert_eq!(first.digest(), second.digest());

    second
        .append_amendment(
            "A material change.".to_owned(),
            timestamp("2026-08-12T09:01:00Z"),
        )
        .unwrap();
    assert_ne!(first.digest(), second.digest());
}

#[test]
fn candidate_manifest_order_does_not_change_its_digest() {
    let candidate_id = workflow_core::CandidateId::new();
    let first_file = candidate_file("src/a.rs", b"a");
    let second_file = candidate_file("src/b.rs", b"b");
    let evidence_id = EvidenceId::new();
    let first = candidate_manifest(
        candidate_id,
        Some("base-revision".to_owned()),
        vec![second_file.clone(), first_file.clone()],
        vec![evidence_id],
    );
    let second = candidate_manifest(
        candidate_id,
        Some("base-revision".to_owned()),
        vec![first_file, second_file],
        vec![evidence_id],
    );

    assert_eq!(first.digest(), second.digest());
}

#[test]
fn candidate_identity_does_not_change_the_exact_content_digest() {
    let first = candidate_manifest(
        workflow_core::CandidateId::new(),
        Some("base-revision".to_owned()),
        vec![candidate_file("src/lib.rs", b"same")],
        Vec::new(),
    );
    let second = candidate_manifest(
        workflow_core::CandidateId::new(),
        Some("base-revision".to_owned()),
        vec![candidate_file("src/lib.rs", b"same")],
        Vec::new(),
    );
    assert_ne!(first.candidate_id(), second.candidate_id());
    assert_eq!(first.digest(), second.digest());
}

#[test]
fn material_candidate_change_invalidates_the_digest() {
    let candidate_id = workflow_core::CandidateId::new();
    let original = candidate_manifest(
        candidate_id,
        None,
        vec![candidate_file("src/lib.rs", b"first")],
        vec![],
    );
    let changed = candidate_manifest(
        candidate_id,
        None,
        vec![candidate_file("src/lib.rs", b"second")],
        vec![],
    );
    assert_ne!(original.digest(), changed.digest());
}

#[test]
fn deserialization_cannot_bypass_candidate_validation() {
    let file = candidate_file("src/lib.rs", b"content");
    let manifest = candidate_manifest(workflow_core::CandidateId::new(), None, vec![file], vec![]);
    let mut value = serde_json::to_value(manifest).unwrap();
    let files = value["files"].as_array_mut().unwrap();
    files.push(files[0].clone());
    assert!(serde_json::from_value::<CandidateManifest>(value).is_err());
}

#[test]
fn evidence_requires_a_captured_result_or_explicit_skip_reason() {
    let mut evidence = EvidenceRecord {
        id: EvidenceId::new(),
        candidate_digest: ContentDigest::of(b"candidate"),
        kind: EvidenceKind::Test,
        invocation: "bun test".to_owned(),
        tool: "bun".to_owned(),
        tool_version: "1.3.14".to_owned(),
        started_at: timestamp("2026-08-12T09:00:00Z"),
        finished_at: timestamp("2026-08-12T09:00:01Z"),
        exit_code: None,
        output_digest: ContentDigest::of(b"output"),
        status: EvidenceStatus::Passed,
        skip_reason: None,
    };
    assert_eq!(
        evidence.validate(),
        Err(EvidenceValidationError::InvalidExitCode)
    );

    evidence.status = EvidenceStatus::Skipped;
    assert_eq!(
        evidence.validate(),
        Err(EvidenceValidationError::MissingSkipReason)
    );
    evidence.skip_reason = Some("No frontend is present in this project.".to_owned());
    assert!(evidence.validate().is_ok());
}

#[test]
fn digest_text_is_canonical_lowercase_hexadecimal() {
    let digest = ContentDigest::of(b"canonical");
    assert_eq!(digest.to_string().parse::<ContentDigest>().unwrap(), digest);
    assert!(
        digest
            .to_string()
            .to_uppercase()
            .parse::<ContentDigest>()
            .is_err()
    );
}

#[test]
fn protocol_v1_core_identifiers_have_fixed_vectors() {
    let amendment = RequestAmendment {
        sequence: 1,
        text: "Preserve compatibility.".to_owned(),
        received_at: timestamp("2026-08-15T12:00:00Z"),
    };
    let mut request = RequestRecord::new(
        "Original request".to_owned(),
        vec![
            ContentDigest::of(b"attachment-b"),
            ContentDigest::of(b"attachment-a"),
        ],
    );
    request
        .append_amendment(amendment.text.clone(), amendment.received_at)
        .unwrap();
    let candidate = CandidateManifest::new(
        CandidateId::from_str("0190f0a0-0000-7000-8000-000000000003").unwrap(),
        Some("base-revision".to_owned()),
        vec![candidate_file("src/lib.rs", b"candidate content")],
        CandidateDigests {
            configuration: ContentDigest::of(b"configuration"),
            dependency_state: ContentDigest::of(b"dependencies"),
            diff: ContentDigest::of(b"diff"),
            environment: ContentDigest::of(b"environment"),
        },
        vec![EvidenceId::from_str("0190f0a0-0000-7000-8000-000000000004").unwrap()],
    )
    .unwrap();
    let receipt = ArbitrationReceipt {
        arbiter_verdict_digest: ContentDigest::of(b"arbiter"),
        candidate_digest: candidate.digest(),
        candidate_id: candidate.candidate_id(),
        evidence_ids: BTreeSet::from([EvidenceId::from_str(
            "0190f0a0-0000-7000-8000-000000000004",
        )
        .unwrap()]),
        finalized_at: timestamp("2026-08-15T12:01:00Z"),
        functional_review_digest: Some(ContentDigest::of(b"functional")),
        id: ReceiptId::from_str("0190f0a0-0000-7000-8000-000000000005").unwrap(),
        request_digest: request.digest(),
        security_review_digest: Some(ContentDigest::of(b"security")),
        workflow_id: WorkflowId::from_str("0190f0a0-0000-7000-8000-000000000006").unwrap(),
    };

    assert_eq!(
        amendment.digest().to_string(),
        "2ee642de18324a1131469713df26e08887c70007d238628956a2b6c3a43cefdd"
    );
    assert_eq!(
        request.digest().to_string(),
        "d90d96c050052cb046330cabdc7b53f2be00e53a5da8f5ef95575fabf67209b6"
    );
    assert_eq!(
        candidate.digest().to_string(),
        "97b64aaec2033a80c77fbda0af6a462585ed342536d7d7b41d68c3b7aea3e40a"
    );
    assert_eq!(
        receipt.digest().to_string(),
        "ea2510c962b9498ac63df8a32406d7f9d976a5560d25c882f820d3711d92e61c"
    );
    assert_eq!(
        workflow_core::ProjectId::from_stable_key("project-key").to_string(),
        "30e0589a-065f-8bc8-80ce-71978be72a2d"
    );
}

#[test]
fn approval_requires_every_requirement_and_known_evidence() {
    let evidence_id = EvidenceId::new();
    let required = BTreeSet::from(["frontend".to_owned(), "backend".to_owned()]);
    let available = BTreeSet::from([evidence_id]);
    let verdict = ArbiterVerdict {
        decision: ArbiterDecision::Approved,
        candidate_digest: ContentDigest::of(b"candidate"),
        requirements: vec![RequirementDecision {
            requirement_id: "backend".to_owned(),
            status: RequirementStatus::Satisfied,
            evidence_ids: BTreeSet::from([evidence_id]),
        }],
        findings: vec![],
        repair_target: None,
    };
    assert_eq!(
        verdict.validate(&required, &available),
        Err(VerdictValidationError::MissingRequirement {
            requirement_id: "frontend".to_owned(),
        })
    );
}

#[test]
fn approval_rejects_unmet_requirements_and_severe_findings() {
    let evidence_id = EvidenceId::new();
    let required = BTreeSet::from(["security".to_owned()]);
    let available = BTreeSet::from([evidence_id]);
    let mut verdict = ArbiterVerdict {
        decision: ArbiterDecision::Approved,
        candidate_digest: ContentDigest::of(b"candidate"),
        requirements: vec![RequirementDecision {
            requirement_id: "security".to_owned(),
            status: RequirementStatus::Unsatisfied,
            evidence_ids: BTreeSet::from([evidence_id]),
        }],
        findings: vec![],
        repair_target: None,
    };
    assert!(matches!(
        verdict.validate(&required, &available),
        Err(VerdictValidationError::UnmetRequirement { .. })
    ));

    verdict.requirements[0].status = RequirementStatus::Satisfied;
    verdict.findings.push(Finding {
        severity: FindingSeverity::High,
        summary: "Unresolved trust-boundary flaw".to_owned(),
        evidence_ids: BTreeSet::from([evidence_id]),
    });
    assert_eq!(
        verdict.validate(&required, &available),
        Err(VerdictValidationError::SevereFinding)
    );

    verdict.decision = ArbiterDecision::Rejected;
    verdict.repair_target = Some(RepairTarget::Architecture);
    assert!(verdict.validate(&required, &available).is_ok());
}
