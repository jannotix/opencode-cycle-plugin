use std::collections::BTreeSet;

use workflow_core::{
    ContentDigest, EvidenceId, Finding, FindingSeverity, RepairTarget, RequirementDecision,
    RequirementStatus, ReviewDecision, ReviewVerdict, WorkflowRole,
};

fn verdict(role: WorkflowRole, evidence_id: EvidenceId) -> ReviewVerdict {
    ReviewVerdict {
        candidate_digest: ContentDigest::of(b"candidate"),
        decision: ReviewDecision::Approved,
        findings: Vec::new(),
        repair_target: None,
        requirements: vec![RequirementDecision {
            evidence_ids: BTreeSet::from([evidence_id]),
            requirement_id: "REQ-1".to_owned(),
            status: RequirementStatus::Satisfied,
        }],
        role,
    }
}

#[test]
fn only_independent_review_roles_can_finalize_complete_evidence_bound_verdicts() {
    let evidence_id = EvidenceId::new();
    let requirements = BTreeSet::from(["REQ-1".to_owned()]);
    let evidence = BTreeSet::from([evidence_id]);
    assert!(
        verdict(WorkflowRole::FunctionalReviewer, evidence_id)
            .validate(&requirements, &evidence)
            .is_ok()
    );
    assert!(
        verdict(WorkflowRole::SecurityArchitectureReviewer, evidence_id)
            .validate(&requirements, &evidence)
            .is_ok()
    );
    assert!(
        verdict(WorkflowRole::Executor, evidence_id)
            .validate(&requirements, &evidence)
            .is_err()
    );
}

#[test]
fn approval_rejects_unmet_requirements_severe_findings_and_unknown_evidence() {
    let evidence_id = EvidenceId::new();
    let requirements = BTreeSet::from(["REQ-1".to_owned()]);
    let evidence = BTreeSet::from([evidence_id]);
    let mut review = verdict(WorkflowRole::FunctionalReviewer, evidence_id);
    review.requirements[0].status = RequirementStatus::Unsatisfied;
    assert!(review.validate(&requirements, &evidence).is_err());
    review.requirements[0].status = RequirementStatus::Satisfied;
    review.findings.push(Finding {
        evidence_ids: BTreeSet::from([evidence_id]),
        severity: FindingSeverity::High,
        summary: "Severe regression".to_owned(),
    });
    assert!(review.validate(&requirements, &evidence).is_err());
    review.decision = ReviewDecision::Rejected;
    review.repair_target = Some(RepairTarget::Execution);
    assert!(review.validate(&requirements, &evidence).is_ok());
    review.findings[0].evidence_ids = BTreeSet::from([EvidenceId::new()]);
    assert!(review.validate(&requirements, &evidence).is_err());
}
