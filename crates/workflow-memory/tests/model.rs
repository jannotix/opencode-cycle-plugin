mod common;

use workflow_core::EvidenceId;
use workflow_memory::{ConfidenceClass, MemoryError, MemoryKind, MemoryState};

#[test]
fn trust_classes_remain_distinct_and_inferred_rules_fail() {
    let (_temporary, _path, project, event) = common::database();
    let mut entry = common::entry(project, event, "Constraint", "Use stable dependencies");
    entry.confidence = ConfidenceClass::Inferred;
    entry.kind = MemoryKind::Constraint;
    assert_eq!(entry.validate(), Err(MemoryError::InferredRule));
    assert!(!entry.can_apply_as_rule());

    entry.kind = MemoryKind::Convention;
    assert!(entry.validate().is_ok());
    assert!(!entry.can_apply_as_rule());

    entry.confidence = ConfidenceClass::Verified;
    assert_eq!(entry.validate(), Err(MemoryError::UnverifiedClaim));
    entry.provenance.evidence_ids.insert(EvidenceId::new());
    assert!(entry.validate().is_ok());
    assert!(entry.can_apply_as_rule());
}

#[test]
fn supersession_retains_the_prior_entry_and_sensitive_content_is_rejected() {
    let (_temporary, _path, project, event) = common::database();
    let mut prior = common::entry(project, event, "Decision", "Use port 8000");
    let replacement = common::entry(project, event, "Decision", "Use port 9000");
    prior.supersede(&replacement).unwrap();
    assert_eq!(prior.state, MemoryState::Superseded);
    assert_eq!(prior.superseded_by, Some(replacement.id));

    let mut unsafe_entry = replacement;
    unsafe_entry.detail = "Authorization: Bearer private-value".to_owned();
    assert_eq!(unsafe_entry.validate(), Err(MemoryError::SensitiveContent));
}
