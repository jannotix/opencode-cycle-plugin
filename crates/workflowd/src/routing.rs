use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use workflow_core::{
    ReceiptId, RiskCategory, RiskFact, RiskSource, RoutingDecision, RoutingInput,
    UserRoutingPreference, WorkflowId, WorkflowRole, route_workflow,
};
use workflow_ipc::audit::{AuditData, AuditObservation};
use workflow_ledger::{CheckpointKey, LedgerEntry};
use workflow_store::Store;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RoutingEvidence {
    pub facts: Vec<RiskFact>,
    pub rationales: BTreeMap<RiskCategory, Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct RoutingRequest {
    pub critical_downgrade_approval: Option<ReceiptId>,
    pub evidence: RoutingEvidence,
    pub preference: UserRoutingPreference,
    pub project_key: String,
    pub timestamp_unix_millis: i64,
    pub workflow_id: WorkflowId,
}

pub struct RecordedRoutingDecision {
    pub decision: RoutingDecision,
    pub ledger_entry: LedgerEntry,
}

pub fn automatic_evidence(original_request: &str, affected_paths: &[String]) -> RoutingEvidence {
    let normalized = original_request.to_ascii_lowercase();
    let mut rationales = BTreeMap::<RiskCategory, BTreeSet<String>>::new();
    for (category, markers) in REQUEST_MARKERS {
        if markers
            .iter()
            .any(|marker| contains_marker(&normalized, marker))
        {
            rationales
                .entry(*category)
                .or_default()
                .insert("original_request".to_owned());
        }
    }
    for path in affected_paths {
        classify_path(path, &mut rationales);
    }
    if rationales.keys().all(|category| !category.is_critical()) {
        if !affected_paths.is_empty() && affected_paths.len() <= 3 {
            rationales
                .entry(RiskCategory::LocalizedChange)
                .or_default()
                .insert("bounded_path_count".to_owned());
        }
        if !affected_paths.is_empty()
            && affected_paths.iter().all(|path| {
                let path = path.to_ascii_lowercase();
                path.contains("test") || path.contains("spec") || path.contains("fixture")
            })
        {
            rationales
                .entry(RiskCategory::TestOnly)
                .or_default()
                .insert("test_only_paths".to_owned());
        }
    }
    RoutingEvidence {
        facts: rationales
            .iter()
            .map(|(category, reasons)| RiskFact {
                category: *category,
                path_backed: reasons.iter().any(|reason| {
                    reason != "original_request"
                        && reason != "bounded_path_count"
                        && reason != "test_only_paths"
                }),
                source: RiskSource::Deterministic,
            })
            .collect(),
        rationales: rationales
            .into_iter()
            .map(|(category, values)| (category, values.into_iter().collect()))
            .collect(),
    }
}

pub fn decide_and_record(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    request: RoutingRequest,
) -> Result<RecordedRoutingDecision, crate::audit::AuditError> {
    let decision = route_workflow(&RoutingInput {
        facts: request.evidence.facts,
        preference: request.preference,
        critical_downgrade_approval: request.critical_downgrade_approval,
    });
    let metadata = BTreeMap::from([
        ("mode".to_owned(), enum_name(decision.mode)),
        (
            "critical_categories".to_owned(),
            category_list(&decision.critical_categories),
        ),
        (
            "advisory_categories".to_owned(),
            category_list(&decision.advisory_categories),
        ),
        (
            "rationale".to_owned(),
            serde_json::to_string(&request.evidence.rationales).unwrap_or_else(|_| "{}".to_owned()),
        ),
        (
            "critical_downgrade_approval".to_owned(),
            decision
                .downgrade_approval
                .map(|receipt| receipt.to_string())
                .unwrap_or_else(|| "none".to_owned()),
        ),
    ]);
    let ledger_entry = crate::audit::record(
        store,
        checkpoint_key,
        AuditObservation {
            actor_id: "workflowd".to_owned(),
            candidate_id: None,
            data: AuditData::Workflow {
                action: "route_selected".to_owned(),
            },
            evidence_ids: BTreeSet::new(),
            files: BTreeSet::new(),
            metadata,
            model: None,
            project_key: request.project_key,
            role: None::<WorkflowRole>,
            session_id: None,
            task_id: None,
            timestamp_unix_millis: request.timestamp_unix_millis,
            workflow_id: Some(request.workflow_id),
        },
    )?;
    Ok(RecordedRoutingDecision {
        decision,
        ledger_entry,
    })
}

fn classify_path(path: &str, rationales: &mut BTreeMap<RiskCategory, BTreeSet<String>>) {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let mappings = [
        (RiskCategory::DatabaseMigration, ["/migrations/", ".sql"]),
        (RiskCategory::Packaging, ["/installer/", "/packaging/"]),
        (RiskCategory::Deployment, ["/deploy/", "/k8s/"]),
    ];
    for (category, markers) in mappings {
        if markers.iter().any(|marker| normalized.contains(marker)) {
            rationales
                .entry(category)
                .or_default()
                .insert(path.to_owned());
        }
    }
    if [
        "cargo.toml",
        "package.json",
        "pyproject.toml",
        "requirements.txt",
        "go.mod",
        "pom.xml",
    ]
    .iter()
    .any(|manifest| normalized.ends_with(manifest))
    {
        rationales
            .entry(RiskCategory::NewDependency)
            .or_default()
            .insert(path.to_owned());
    }
    if normalized.starts_with("docs/") || normalized.ends_with(".md") {
        rationales
            .entry(RiskCategory::Documentation)
            .or_default()
            .insert(path.to_owned());
    }
}

fn contains_marker(text: &str, marker: &str) -> bool {
    if marker.contains(' ') || marker.contains('-') {
        return text.contains(marker);
    }
    text.split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .any(|token| token == marker)
}

fn category_list(categories: &[RiskCategory]) -> String {
    categories
        .iter()
        .map(|category| format!("{category:?}").to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(",")
}

fn enum_name(mode: workflow_core::WorkflowMode) -> String {
    format!("{mode:?}").to_ascii_lowercase()
}

const REQUEST_MARKERS: &[(RiskCategory, &[&str])] = &[
    (
        RiskCategory::Authentication,
        &["authentication", "login", "sign-in"],
    ),
    (
        RiskCategory::Authorization,
        &["authorization", "rbac", "access control"],
    ),
    (
        RiskCategory::Cryptography,
        &["cryptography", "encryption", "cipher"],
    ),
    (RiskCategory::Secrets, &["secret", "credential", "api key"]),
    (
        RiskCategory::TrustBoundary,
        &["trust boundary", "sandbox", "isolation"],
    ),
    (
        RiskCategory::DatabaseMigration,
        &["database migration", "schema migration"],
    ),
    (
        RiskCategory::Persistence,
        &["persistence", "sqlite", "postgres"],
    ),
    (
        RiskCategory::DataIntegrity,
        &["data integrity", "transaction", "atomic"],
    ),
    (
        RiskCategory::NewDependency,
        &["new dependency", "add dependency"],
    ),
    (
        RiskCategory::PublicApi,
        &["public api", "api endpoint", "public interface"],
    ),
    (RiskCategory::Protocol, &["protocol", "ipc", "wire format"]),
    (RiskCategory::Schema, &["schema"]),
    (
        RiskCategory::Compatibility,
        &["compatibility", "cross-platform"],
    ),
    (
        RiskCategory::CrossLayer,
        &["frontend", "backend", "full-stack", "cross-layer"],
    ),
    (
        RiskCategory::Concurrency,
        &["concurrency", "parallel", "thread-safe"],
    ),
    (RiskCategory::DistributedSystem, &["distributed", "cluster"]),
    (
        RiskCategory::Packaging,
        &["packaging", "installer", "archive"],
    ),
    (RiskCategory::Installation, &["installation"]),
    (
        RiskCategory::Update,
        &["breaking update", "version upgrade"],
    ),
    (RiskCategory::Release, &["release", "publish"]),
    (RiskCategory::Deployment, &["deployment", "deploy"]),
    (RiskCategory::LargeRefactor, &["large refactor", "rewrite"]),
    (RiskCategory::HighImpact, &["high impact", "critical"]),
    (
        RiskCategory::DifficultToReverse,
        &["irreversible", "difficult to reverse"],
    ),
];
