use workflow_core::{
    ArchitectureError, ArchitecturePlan, ContentDigest, PlannedTask, Requirement, TaskId,
};

fn requirement(id: &str) -> Requirement {
    Requirement {
        acceptance_criteria: vec!["The behavior is verified end to end.".to_owned()],
        id: id.to_owned(),
        statement: format!("Implement requirement {id}."),
    }
}

fn task(scope: &str, requirement_id: &str, dependencies: Vec<TaskId>) -> PlannedTask {
    PlannedTask {
        acceptance_criteria: vec!["The bounded task passes its verification.".to_owned()],
        dependencies,
        id: TaskId::new(),
        objective: "Implement the smallest complete production change.".to_owned(),
        requirement_ids: vec![requirement_id.to_owned()],
        title: "Bounded implementation".to_owned(),
        verification_commands: vec!["project-native-test-command".to_owned()],
        write_scopes: vec![scope.to_owned()],
    }
}

#[test]
fn validates_requirement_coverage_and_an_acyclic_executable_plan() {
    let first = task("backend", "REQ-1", vec![]);
    let second = task("frontend", "REQ-2", vec![first.id]);
    let plan = ArchitecturePlan::validate(
        ContentDigest::of(b"request"),
        vec![requirement("REQ-1"), requirement("REQ-2")],
        vec![first, second],
        vec![],
        vec!["Cross-layer integration".to_owned()],
        vec!["Exercise the real backend through the user interface.".to_owned()],
    )
    .unwrap();

    assert_eq!(plan.requirements.len(), 2);
    assert_eq!(plan.tasks.len(), 2);
    assert_eq!(plan.digest(), plan.digest());
}

#[test]
fn rejects_unknown_uncovered_and_vague_plan_elements() {
    let unknown = task("src", "REQ-2", vec![]);
    assert!(matches!(
        ArchitecturePlan::validate(
            ContentDigest::of(b"request"),
            vec![requirement("REQ-1")],
            vec![unknown],
            vec![],
            vec![],
            vec!["Run integration tests.".to_owned()]
        ),
        Err(ArchitectureError::UnknownRequirement(_))
    ));

    let mut vague = task("src", "REQ-1", vec![]);
    vague.verification_commands.clear();
    assert_eq!(
        ArchitecturePlan::validate(
            ContentDigest::of(b"request"),
            vec![requirement("REQ-1")],
            vec![vague],
            vec![],
            vec![],
            vec!["Run integration tests.".to_owned()]
        ),
        Err(ArchitectureError::InvalidTask)
    );
}

#[test]
fn deserialization_cannot_bypass_dag_validation() {
    let first_id = TaskId::new();
    let second_id = TaskId::new();
    let mut first = task("backend", "REQ-1", vec![second_id]);
    first.id = first_id;
    let mut second = task("frontend", "REQ-1", vec![first_id]);
    second.id = second_id;
    let value = serde_json::json!({
        "assumptions": [],
        "integration_checks": ["Run the end-to-end suite."],
        "request_digest": ContentDigest::of(b"request"),
        "requirements": [requirement("REQ-1")],
        "risks": [],
        "tasks": [first, second]
    });

    assert!(serde_json::from_value::<ArchitecturePlan>(value).is_err());
}
