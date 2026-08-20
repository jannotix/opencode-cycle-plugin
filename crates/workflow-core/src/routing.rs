use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{ReceiptId, WorkflowMode};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskCategory {
    Authentication,
    Authorization,
    Cryptography,
    Secrets,
    TrustBoundary,
    DatabaseMigration,
    Persistence,
    DataIntegrity,
    NewDependency,
    PublicApi,
    Protocol,
    Schema,
    Compatibility,
    CrossLayer,
    Concurrency,
    DistributedSystem,
    Packaging,
    Installation,
    Update,
    Release,
    Deployment,
    LargeRefactor,
    AmbiguousRequirement,
    HighImpact,
    DifficultToReverse,
    Documentation,
    LocalizedChange,
    TestOnly,
}

impl RiskCategory {
    pub const CRITICAL: [Self; 25] = [
        Self::Authentication,
        Self::Authorization,
        Self::Cryptography,
        Self::Secrets,
        Self::TrustBoundary,
        Self::DatabaseMigration,
        Self::Persistence,
        Self::DataIntegrity,
        Self::NewDependency,
        Self::PublicApi,
        Self::Protocol,
        Self::Schema,
        Self::Compatibility,
        Self::CrossLayer,
        Self::Concurrency,
        Self::DistributedSystem,
        Self::Packaging,
        Self::Installation,
        Self::Update,
        Self::Release,
        Self::Deployment,
        Self::LargeRefactor,
        Self::AmbiguousRequirement,
        Self::HighImpact,
        Self::DifficultToReverse,
    ];

    #[must_use]
    pub const fn is_critical(self) -> bool {
        !matches!(
            self,
            Self::Documentation | Self::LocalizedChange | Self::TestOnly
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskSource {
    Deterministic,
    User,
    ModelAdvisory,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct RiskFact {
    pub category: RiskCategory,
    #[serde(default)]
    pub path_backed: bool,
    pub source: RiskSource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UserRoutingPreference {
    Auto,
    Quick,
    Full,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoutingInput {
    pub facts: Vec<RiskFact>,
    pub preference: UserRoutingPreference,
    pub critical_downgrade_approval: Option<ReceiptId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoutingDecision {
    pub mode: WorkflowMode,
    pub critical_categories: Vec<RiskCategory>,
    pub advisory_categories: Vec<RiskCategory>,
    pub user_promoted: bool,
    pub downgrade_approval_required: bool,
    pub downgrade_approval: Option<ReceiptId>,
}

#[must_use]
pub fn route_workflow(input: &RoutingInput) -> RoutingDecision {
    let critical_categories = input
        .facts
        .iter()
        .filter(|fact| fact.source != RiskSource::ModelAdvisory && fact.category.is_critical())
        .map(|fact| fact.category)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let advisory_categories = input
        .facts
        .iter()
        .filter(|fact| fact.source == RiskSource::ModelAdvisory)
        .map(|fact| fact.category)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let path_backed_critical = input.facts.iter().any(|fact| {
        fact.source != RiskSource::ModelAdvisory && fact.category.is_critical() && fact.path_backed
    });
    let user_promoted = input.preference == UserRoutingPreference::Full;
    let requested_downgrade =
        input.preference == UserRoutingPreference::Quick && !critical_categories.is_empty();
    let approved_downgrade = requested_downgrade && input.critical_downgrade_approval.is_some();
    let auto_requires_full = path_backed_critical || critical_categories.len() >= 2;

    RoutingDecision {
        mode: if user_promoted
            || (input.preference == UserRoutingPreference::Quick
                && !critical_categories.is_empty()
                && !approved_downgrade)
            || (input.preference == UserRoutingPreference::Auto && auto_requires_full)
        {
            WorkflowMode::Full
        } else {
            WorkflowMode::Quick
        },
        critical_categories,
        advisory_categories,
        user_promoted,
        downgrade_approval_required: requested_downgrade && !approved_downgrade,
        downgrade_approval: approved_downgrade
            .then_some(input.critical_downgrade_approval)
            .flatten(),
    }
}
