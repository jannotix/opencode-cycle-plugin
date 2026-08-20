use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    ContentDigest, EvidenceId, Finding, FindingSeverity, RepairTarget, RequirementDecision,
    RequirementStatus, WorkflowRole,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ReviewVerdict {
    pub candidate_digest: ContentDigest,
    pub decision: ReviewDecision,
    pub findings: Vec<Finding>,
    pub repair_target: Option<RepairTarget>,
    pub requirements: Vec<RequirementDecision>,
    pub role: WorkflowRole,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReviewValidationError {
    ApprovalHasRepairTarget,
    DuplicateRequirement(String),
    InvalidRole,
    MissingEvidence(String),
    MissingRepairTarget,
    MissingRequirement(String),
    RejectionWithoutBasis,
    SevereFinding,
    UnexpectedRequirement(String),
    UnknownEvidence(EvidenceId),
    UnmetRequirement(String),
}

impl std::fmt::Display for ReviewValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ApprovalHasRepairTarget => "approved review cannot request repair",
            Self::DuplicateRequirement(_) => "review contains a duplicate requirement",
            Self::InvalidRole => "review role is not an independent reviewer",
            Self::MissingEvidence(_) => "review requirement lacks evidence",
            Self::MissingRepairTarget => "rejected review requires a repair target",
            Self::MissingRequirement(_) => "review omits a required decision",
            Self::RejectionWithoutBasis => "rejected review lacks a finding or unmet requirement",
            Self::SevereFinding => "approved review contains a severe finding",
            Self::UnexpectedRequirement(_) => "review references an unknown requirement",
            Self::UnknownEvidence(_) => "review references unavailable evidence",
            Self::UnmetRequirement(_) => "approved review contains an unmet requirement",
        })
    }
}

impl std::error::Error for ReviewValidationError {}

impl ReviewVerdict {
    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        ContentDigest::of(
            &serde_json::to_vec(self).expect("validated review verdicts are serializable"),
        )
    }

    pub fn validate(
        &self,
        required: &BTreeSet<String>,
        available_evidence: &BTreeSet<EvidenceId>,
    ) -> Result<(), ReviewValidationError> {
        if !matches!(
            self.role,
            WorkflowRole::FunctionalReviewer | WorkflowRole::SecurityArchitectureReviewer
        ) {
            return Err(ReviewValidationError::InvalidRole);
        }
        let mut decisions = BTreeMap::new();
        for decision in &self.requirements {
            if !required.contains(&decision.requirement_id) {
                return Err(ReviewValidationError::UnexpectedRequirement(
                    decision.requirement_id.clone(),
                ));
            }
            if decisions
                .insert(decision.requirement_id.as_str(), decision)
                .is_some()
            {
                return Err(ReviewValidationError::DuplicateRequirement(
                    decision.requirement_id.clone(),
                ));
            }
            if decision.evidence_ids.is_empty() {
                return Err(ReviewValidationError::MissingEvidence(
                    decision.requirement_id.clone(),
                ));
            }
            validate_evidence(&decision.evidence_ids, available_evidence)?;
        }
        for requirement in required {
            if !decisions.contains_key(requirement.as_str()) {
                return Err(ReviewValidationError::MissingRequirement(
                    requirement.clone(),
                ));
            }
        }
        for finding in &self.findings {
            if finding.evidence_ids.is_empty() {
                return Err(ReviewValidationError::MissingEvidence("finding".to_owned()));
            }
            validate_evidence(&finding.evidence_ids, available_evidence)?;
        }
        match self.decision {
            ReviewDecision::Approved => {
                if self.repair_target.is_some() {
                    return Err(ReviewValidationError::ApprovalHasRepairTarget);
                }
                if let Some(decision) = self
                    .requirements
                    .iter()
                    .find(|decision| decision.status == RequirementStatus::Unsatisfied)
                {
                    return Err(ReviewValidationError::UnmetRequirement(
                        decision.requirement_id.clone(),
                    ));
                }
                if self.findings.iter().any(|finding| {
                    matches!(
                        finding.severity,
                        FindingSeverity::Critical | FindingSeverity::High
                    )
                }) {
                    return Err(ReviewValidationError::SevereFinding);
                }
            }
            ReviewDecision::Rejected => {
                if self.repair_target.is_none() {
                    return Err(ReviewValidationError::MissingRepairTarget);
                }
                if self.findings.is_empty()
                    && self
                        .requirements
                        .iter()
                        .all(|decision| decision.status == RequirementStatus::Satisfied)
                {
                    return Err(ReviewValidationError::RejectionWithoutBasis);
                }
            }
        }
        Ok(())
    }
}

fn validate_evidence(
    referenced: &BTreeSet<EvidenceId>,
    available: &BTreeSet<EvidenceId>,
) -> Result<(), ReviewValidationError> {
    if let Some(id) = referenced.iter().find(|id| !available.contains(id)) {
        Err(ReviewValidationError::UnknownEvidence(*id))
    } else {
        Ok(())
    }
}
