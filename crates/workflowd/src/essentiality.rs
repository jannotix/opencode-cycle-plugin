use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use workflow_core::{ContentDigest, TaskId};

pub const INSTRUCTIONS: &str = include_str!("prompts/essentiality.md");

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AlternativeCheck {
    ExistingImplementation,
    StandardLibrary,
    NativePlatformCapability,
    InstalledDependency,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposedChangeKind {
    NewAbstraction,
    NewCode,
    NewDependency,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AlternativeEvidence {
    pub check: AlternativeCheck,
    pub source: String,
    pub viable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeProposal {
    pub alternatives: Vec<AlternativeEvidence>,
    pub kind: ProposedChangeKind,
    pub preserves_accessibility: bool,
    pub preserves_safety: bool,
    pub rationale: String,
    pub summary: String,
    pub task_id: TaskId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EssentialityPolicy {
    pub required_checks: Vec<AlternativeCheck>,
    pub require_accessibility_preservation: bool,
    pub require_safety_preservation: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum EssentialityDecision {
    Allowed { constraint_digest: ContentDigest },
    Rejected { reasons: Vec<String> },
}

impl Default for EssentialityPolicy {
    fn default() -> Self {
        Self {
            required_checks: vec![
                AlternativeCheck::ExistingImplementation,
                AlternativeCheck::StandardLibrary,
                AlternativeCheck::NativePlatformCapability,
                AlternativeCheck::InstalledDependency,
            ],
            require_accessibility_preservation: true,
            require_safety_preservation: true,
        }
    }
}

impl EssentialityPolicy {
    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        ContentDigest::of(
            &serde_json::to_vec(self).expect("the essentiality policy is serializable"),
        )
    }

    #[must_use]
    pub fn evaluate(&self, proposal: &ChangeProposal) -> EssentialityDecision {
        let mut reasons = BTreeSet::new();
        if proposal.summary.trim().is_empty() || proposal.rationale.trim().is_empty() {
            reasons.insert("summary and rationale must be explicit".to_owned());
        }
        if self.require_safety_preservation && !proposal.preserves_safety {
            reasons.insert("safety requirements cannot be removed by essentiality".to_owned());
        }
        if self.require_accessibility_preservation && !proposal.preserves_accessibility {
            reasons
                .insert("accessibility requirements cannot be removed by essentiality".to_owned());
        }
        let evidence = proposal
            .alternatives
            .iter()
            .map(|item| (item.check, item))
            .collect::<BTreeMap<_, _>>();
        for check in &self.required_checks {
            match evidence.get(check) {
                None => {
                    reasons.insert(format!("missing {check:?} evidence").to_ascii_lowercase());
                }
                Some(item) if item.source.trim().is_empty() => {
                    reasons.insert(format!("empty {check:?} evidence").to_ascii_lowercase());
                }
                Some(item) if item.viable => {
                    reasons.insert(
                        format!("viable {check:?} alternative exists").to_ascii_lowercase(),
                    );
                }
                Some(_) => {}
            }
        }
        if reasons.is_empty() {
            EssentialityDecision::Allowed {
                constraint_digest: self.digest(),
            }
        } else {
            EssentialityDecision::Rejected {
                reasons: reasons.into_iter().collect(),
            }
        }
    }
}
