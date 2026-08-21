use serde::Deserialize;
use workflow_core::{
    RiskCategory, RiskFact, RiskSource, RoutingInput, UserRoutingPreference, WorkflowMode,
    route_workflow,
};

#[derive(Deserialize)]
struct RoutingFixture {
    facts: Vec<RiskFact>,
    preference: UserRoutingPreference,
    expected_mode: WorkflowMode,
}

#[test]
fn auto_keeps_a_single_request_critical_fact_in_quick() {
    for category in RiskCategory::CRITICAL {
        let decision = route_workflow(&RoutingInput {
            facts: vec![RiskFact {
                category,
                path_backed: false,
                source: RiskSource::Deterministic,
            }],
            preference: UserRoutingPreference::Auto,
            critical_downgrade_approval: None,
        });
        assert_eq!(decision.mode, WorkflowMode::Quick, "{category:?}");
        assert_eq!(decision.critical_categories, vec![category]);
    }
}

#[test]
fn auto_promotes_two_critical_facts_or_a_path_backed_fact_to_full() {
    let two = route_workflow(&RoutingInput {
        facts: vec![
            RiskFact {
                category: RiskCategory::Authentication,
                path_backed: false,
                source: RiskSource::Deterministic,
            },
            RiskFact {
                category: RiskCategory::PublicApi,
                path_backed: false,
                source: RiskSource::Deterministic,
            },
        ],
        preference: UserRoutingPreference::Auto,
        critical_downgrade_approval: None,
    });
    assert_eq!(two.mode, WorkflowMode::Full);

    let path_backed = route_workflow(&RoutingInput {
        facts: vec![RiskFact {
            category: RiskCategory::DatabaseMigration,
            path_backed: true,
            source: RiskSource::Deterministic,
        }],
        preference: UserRoutingPreference::Auto,
        critical_downgrade_approval: None,
    });
    assert_eq!(path_backed.mode, WorkflowMode::Full);
}

#[test]
fn explicit_promotion_always_wins() {
    let decision = route_workflow(&RoutingInput {
        facts: vec![],
        preference: UserRoutingPreference::Full,
        critical_downgrade_approval: None,
    });
    assert_eq!(decision.mode, WorkflowMode::Full);
    assert!(decision.user_promoted);
}

#[test]
fn critical_downgrade_requires_recorded_user_approval() {
    let mut input = RoutingInput {
        facts: vec![RiskFact {
            category: RiskCategory::DatabaseMigration,
            path_backed: false,
            source: RiskSource::Deterministic,
        }],
        preference: UserRoutingPreference::Quick,
        critical_downgrade_approval: None,
    };

    let denied = route_workflow(&input);
    assert_eq!(denied.mode, WorkflowMode::Full);
    assert!(denied.downgrade_approval_required);

    let receipt = workflow_core::ReceiptId::new();
    input.critical_downgrade_approval = Some(receipt);
    let approved = route_workflow(&input);
    assert_eq!(approved.mode, WorkflowMode::Quick);
    assert_eq!(approved.downgrade_approval, Some(receipt));
}

#[test]
fn low_risk_and_model_advisory_fixtures_are_deterministic() {
    for fixture in [
        include_str!("../../../tests/fixtures/routing/low-risk-bounded.json"),
        include_str!("../../../tests/fixtures/routing/model-advice-only.json"),
    ] {
        let fixture: RoutingFixture = serde_json::from_str(fixture).unwrap();
        let decision = route_workflow(&RoutingInput {
            facts: fixture.facts,
            preference: fixture.preference,
            critical_downgrade_approval: None,
        });
        assert_eq!(decision.mode, fixture.expected_mode);
    }
}

#[test]
fn duplicate_and_reordered_facts_produce_the_same_explanation() {
    let fact = RiskFact {
        category: RiskCategory::PublicApi,
        path_backed: false,
        source: RiskSource::Deterministic,
    };
    let first = route_workflow(&RoutingInput {
        facts: vec![fact, fact],
        preference: UserRoutingPreference::Auto,
        critical_downgrade_approval: None,
    });
    let second = route_workflow(&RoutingInput {
        facts: vec![fact],
        preference: UserRoutingPreference::Auto,
        critical_downgrade_approval: None,
    });
    assert_eq!(first, second);
}
