use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{ContentDigest, EvidenceId, RepairTarget};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ArbiterDecision {
    Approved,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Satisfied,
    Unsatisfied,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct RequirementDecision {
    pub requirement_id: String,
    pub status: RequirementStatus,
    pub evidence_ids: BTreeSet<EvidenceId>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

impl FindingSeverity {
    const fn is_severe(self) -> bool {
        matches!(self, Self::Critical | Self::High)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub severity: FindingSeverity,
    pub summary: String,
    pub evidence_ids: BTreeSet<EvidenceId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ArbiterVerdict {
    pub decision: ArbiterDecision,
    pub candidate_digest: ContentDigest,
    pub requirements: Vec<RequirementDecision>,
    pub findings: Vec<Finding>,
    pub repair_target: Option<RepairTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VerdictValidationError {
    DuplicateRequirement { requirement_id: String },
    MissingRequirement { requirement_id: String },
    UnexpectedRequirement { requirement_id: String },
    MissingEvidence { requirement_id: String },
    UnknownEvidence { evidence_id: EvidenceId },
    UnmetRequirement { requirement_id: String },
    SevereFinding,
    ApprovalHasRepairTarget,
    MissingRepairTarget,
    RejectionWithoutBasis,
}

impl ArbiterVerdict {
    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        ContentDigest::of(
            &serde_json::to_vec(self).expect("validated arbiter verdicts are serializable"),
        )
    }

    pub fn validate(
        &self,
        required: &BTreeSet<String>,
        available_evidence: &BTreeSet<EvidenceId>,
    ) -> Result<(), VerdictValidationError> {
        let mut decisions = BTreeMap::new();
        for decision in &self.requirements {
            if decisions
                .insert(decision.requirement_id.as_str(), decision)
                .is_some()
            {
                return Err(VerdictValidationError::DuplicateRequirement {
                    requirement_id: decision.requirement_id.clone(),
                });
            }
            if !required.contains(&decision.requirement_id) {
                return Err(VerdictValidationError::UnexpectedRequirement {
                    requirement_id: decision.requirement_id.clone(),
                });
            }
        }
        for requirement_id in required {
            let decision = decisions.get(requirement_id.as_str()).ok_or_else(|| {
                VerdictValidationError::MissingRequirement {
                    requirement_id: requirement_id.clone(),
                }
            })?;
            if decision.evidence_ids.is_empty() {
                return Err(VerdictValidationError::MissingEvidence {
                    requirement_id: requirement_id.clone(),
                });
            }
            validate_evidence(&decision.evidence_ids, available_evidence)?;
            if self.decision == ArbiterDecision::Approved
                && decision.status != RequirementStatus::Satisfied
            {
                return Err(VerdictValidationError::UnmetRequirement {
                    requirement_id: requirement_id.clone(),
                });
            }
        }
        for finding in &self.findings {
            validate_evidence(&finding.evidence_ids, available_evidence)?;
        }

        match self.decision {
            ArbiterDecision::Approved => {
                if self.repair_target.is_some() {
                    return Err(VerdictValidationError::ApprovalHasRepairTarget);
                }
                if self
                    .findings
                    .iter()
                    .any(|finding| finding.severity.is_severe())
                {
                    return Err(VerdictValidationError::SevereFinding);
                }
            }
            ArbiterDecision::Rejected => {
                if self.repair_target.is_none() {
                    return Err(VerdictValidationError::MissingRepairTarget);
                }
                let has_basis = self
                    .requirements
                    .iter()
                    .any(|decision| decision.status == RequirementStatus::Unsatisfied)
                    || !self.findings.is_empty();
                if !has_basis {
                    return Err(VerdictValidationError::RejectionWithoutBasis);
                }
            }
        }
        Ok(())
    }
}

fn validate_evidence(
    referenced: &BTreeSet<EvidenceId>,
    available: &BTreeSet<EvidenceId>,
) -> Result<(), VerdictValidationError> {
    if let Some(evidence_id) = referenced
        .iter()
        .find(|evidence_id| !available.contains(evidence_id))
    {
        Err(VerdictValidationError::UnknownEvidence {
            evidence_id: *evidence_id,
        })
    } else {
        Ok(())
    }
}
