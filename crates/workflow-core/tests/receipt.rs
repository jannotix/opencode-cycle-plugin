use std::collections::BTreeSet;

use workflow_core::{
    ArbitrationReceipt, CandidateId, ContentDigest, EvidenceId, ReceiptId, WorkflowId,
    WorkflowTimestamp,
};

#[test]
fn receipt_digest_binds_request_candidate_reviews_evidence_and_arbiter() {
    let evidence = EvidenceId::new();
    let receipt = ArbitrationReceipt {
        arbiter_verdict_digest: ContentDigest::of(b"arbiter"),
        candidate_digest: ContentDigest::of(b"candidate"),
        candidate_id: CandidateId::new(),
        evidence_ids: BTreeSet::from([evidence]),
        finalized_at: WorkflowTimestamp::parse("2026-08-12T10:00:00Z").unwrap(),
        functional_review_digest: Some(ContentDigest::of(b"functional")),
        id: ReceiptId::new(),
        request_digest: ContentDigest::of(b"request"),
        security_review_digest: Some(ContentDigest::of(b"security")),
        workflow_id: WorkflowId::new(),
    };
    let mut changed = receipt.clone();
    changed.evidence_ids.insert(EvidenceId::new());
    assert_ne!(receipt.digest(), changed.digest());
    changed = receipt.clone();
    changed.request_digest = ContentDigest::of(b"different request");
    assert_ne!(receipt.digest(), changed.digest());
}
