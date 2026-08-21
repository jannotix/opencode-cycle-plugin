use std::fs;

use workflow_core::{
    ArchitecturePlan, ContentDigest, EvidenceKind, PlannedTask, Requirement, TaskId,
};
use workflowd::verification::{VerificationExecutor, VerificationPlan, discover};

fn architecture(scopes: Vec<String>, commands: Vec<String>) -> ArchitecturePlan {
    ArchitecturePlan::validate(
        ContentDigest::of(b"request"),
        vec![Requirement {
            acceptance_criteria: vec!["The feature works end to end.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Implement the complete feature.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["All required checks pass.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Implement the bounded feature.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Feature".to_owned(),
            verification_commands: commands,
            write_scopes: scopes,
        }],
        vec![],
        vec![],
        vec!["Run the complete integration flow.".to_owned()],
    )
    .unwrap()
}

#[test]
fn adapters_declare_commands_preconditions_risk_timeout_and_mandatory_status() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("package.json"),
        r#"{"scripts":{"lint":"lint","test":"test","test:e2e":"e2e","test:a11y":"a11y"}}"#,
    )
    .unwrap();
    fs::write(directory.path().join("bun.lock"), "lock").unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec!["frontend/components/Login.tsx".to_owned()],
            vec!["bun test".to_owned()],
        ),
    )
    .unwrap();

    assert!(plan.gates.iter().all(|gate| {
        !gate.name.is_empty()
            && !gate.precondition.is_empty()
            && gate.timeout_seconds > 0
            && gate.mandatory
    }));
    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name.starts_with("browser:") && gate.kind == EvidenceKind::Browser)
    );
    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name.starts_with("accessibility:"))
    );
    assert!(
        plan.gates
            .iter()
            .any(|gate| matches!(gate.executor, VerificationExecutor::SecretScan))
    );
    assert_eq!(plan.evidence_ids().len(), plan.gates.len());
}

#[test]
fn missing_mandatory_database_and_browser_capabilities_block_explicitly() {
    let directory = tempfile::tempdir().unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec!["migrations/001.sql".to_owned(), "ui/page.tsx".to_owned()],
            vec!["project-test".to_owned()],
        ),
    )
    .unwrap();
    let unavailable: Vec<_> = plan
        .gates
        .iter()
        .filter(|gate| matches!(gate.executor, VerificationExecutor::Unavailable { .. }))
        .collect();
    assert_eq!(unavailable.len(), 3);
    assert!(unavailable.iter().all(|gate| gate.mandatory));
}

#[test]
fn unsafe_commands_are_rejected_without_a_shell() {
    let directory = tempfile::tempdir().unwrap();
    for command in ["rm -rf project", "bun test && deploy", "git reset --hard"] {
        assert!(
            discover(
                directory.path(),
                &architecture(vec!["src".to_owned()], vec![command.to_owned()])
            )
            .is_err()
        );
    }

    let value = serde_json::to_value(
        discover(
            directory.path(),
            &architecture(vec!["src".to_owned()], vec!["bun test".to_owned()]),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(serde_json::from_value::<VerificationPlan>(value).is_ok());
}

#[test]
fn conventional_project_adapters_cover_database_browser_accessibility_security_and_package() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("package.json"),
        r#"{"scripts":{"test:database":"db","test:browser":"browser","test:accessibility":"a11y","audit":"audit","license:check":"licenses","package:verify":"package"}}"#,
    )
    .unwrap();
    fs::write(directory.path().join("bun.lock"), "lock").unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec![
                "migrations/001.sql".to_owned(),
                "ui/page.tsx".to_owned(),
                "package.json".to_owned(),
            ],
            vec!["rustc --version".to_owned()],
        ),
    )
    .unwrap();

    for (prefix, kind) in [
        ("database:", EvidenceKind::Database),
        ("browser:", EvidenceKind::Browser),
        ("accessibility:", EvidenceKind::Browser),
        ("security:", EvidenceKind::Security),
        ("package:", EvidenceKind::Package),
    ] {
        assert!(
            plan.gates
                .iter()
                .any(|gate| gate.name.starts_with(prefix) && gate.kind == kind),
            "missing {prefix} adapter"
        );
    }
    assert!(
        plan.gates
            .iter()
            .all(|gate| !matches!(gate.executor, VerificationExecutor::Unavailable { .. }))
    );
}

#[test]
fn dependency_and_packaging_changes_block_without_required_project_adapters() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("package.json"),
        r#"{"scripts":{"test":"test"}}"#,
    )
    .unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec!["package.json".to_owned()],
            vec!["rustc --version".to_owned()],
        ),
    )
    .unwrap();
    let unavailable: Vec<_> = plan
        .gates
        .iter()
        .filter(|gate| matches!(gate.executor, VerificationExecutor::Unavailable { .. }))
        .map(|gate| gate.name.as_str())
        .collect();

    assert!(unavailable.contains(&"security:dependency-vulnerability"));
    assert!(unavailable.contains(&"security:dependency-license"));
    assert!(unavailable.contains(&"package:production-artifact"));
}
