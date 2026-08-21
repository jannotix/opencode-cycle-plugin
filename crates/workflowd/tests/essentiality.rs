use workflow_core::TaskId;
use workflowd::essentiality::{
    AlternativeCheck, AlternativeEvidence, ChangeProposal, EssentialityDecision,
    EssentialityPolicy, ProposedChangeKind,
};

fn proposal() -> ChangeProposal {
    ChangeProposal {
        alternatives: [
            AlternativeCheck::ExistingImplementation,
            AlternativeCheck::StandardLibrary,
            AlternativeCheck::NativePlatformCapability,
            AlternativeCheck::InstalledDependency,
        ]
        .into_iter()
        .map(|check| AlternativeEvidence {
            check,
            source: format!("verified {check:?}"),
            viable: false,
        })
        .collect(),
        kind: ProposedChangeKind::NewCode,
        preserves_accessibility: true,
        preserves_safety: true,
        rationale: "No existing capability satisfies the bounded requirement.".to_owned(),
        summary: "Add the minimum implementation.".to_owned(),
        task_id: TaskId::new(),
    }
}

#[test]
fn new_code_requires_evidence_for_every_existing_alternative_class() {
    let policy = EssentialityPolicy::default();
    assert_eq!(
        policy.evaluate(&proposal()),
        EssentialityDecision::Allowed {
            constraint_digest: policy.digest()
        }
    );

    let mut incomplete = proposal();
    incomplete.alternatives.pop();
    assert!(matches!(
        policy.evaluate(&incomplete),
        EssentialityDecision::Rejected { .. }
    ));
}

#[test]
fn viable_existing_capability_rejects_unnecessary_work() {
    let mut unnecessary = proposal();
    unnecessary.alternatives[0].viable = true;
    let decision = EssentialityPolicy::default().evaluate(&unnecessary);

    assert!(
        matches!(decision, EssentialityDecision::Rejected { reasons } if reasons.iter().any(|reason| reason.contains("viable")))
    );
}

#[test]
fn safety_and_accessibility_cannot_be_removed() {
    let mut unsafe_proposal = proposal();
    unsafe_proposal.preserves_accessibility = false;
    unsafe_proposal.preserves_safety = false;
    let decision = EssentialityPolicy::default().evaluate(&unsafe_proposal);

    assert!(matches!(decision, EssentialityDecision::Rejected { reasons } if reasons.len() == 2));
}
