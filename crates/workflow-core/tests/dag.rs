use std::collections::BTreeSet;

use workflow_core::{DagError, TaskDag, TaskId, TaskNode, WorkflowRole};

fn node(scope: &str, dependencies: Vec<TaskId>) -> TaskNode {
    TaskNode {
        id: TaskId::new(),
        owner: WorkflowRole::Executor,
        write_scopes: vec![scope.to_owned()],
        dependencies,
    }
}

#[test]
fn rejects_cycles_and_missing_dependencies() {
    let mut first = node("backend", vec![]);
    let second = node("frontend", vec![first.id]);
    first.dependencies.push(second.id);
    assert_eq!(TaskDag::validate(vec![first, second]), Err(DagError::Cycle));

    let missing = node("backend", vec![TaskId::new()]);
    assert!(matches!(
        TaskDag::validate(vec![missing]),
        Err(DagError::MissingDependency { .. })
    ));
}

#[test]
fn rejects_overlapping_scope_and_invalid_ownership() {
    let first = node("src", vec![]);
    let second = node("src/api/mod.rs", vec![]);
    assert!(matches!(
        TaskDag::validate(vec![first, second]),
        Err(DagError::OverlappingScope { .. })
    ));

    let mut invalid = node("docs", vec![]);
    invalid.owner = WorkflowRole::Architect;
    assert!(matches!(
        TaskDag::validate(vec![invalid]),
        Err(DagError::InvalidOwner { .. })
    ));
}

#[test]
fn rejects_unsafe_or_duplicated_scope() {
    for scope in ["", ".", "../outside", "/absolute", "C:/absolute"] {
        assert!(matches!(
            TaskDag::validate(vec![node(scope, vec![])]),
            Err(DagError::InvalidScope { .. })
        ));
    }

    let mut duplicate = node("src/api", vec![]);
    duplicate.write_scopes.push("src/api".to_owned());
    assert!(matches!(
        TaskDag::validate(vec![duplicate]),
        Err(DagError::OverlappingScope { .. })
    ));
}

#[test]
fn exposes_only_dependency_ready_tasks() {
    let first = node("backend", vec![]);
    let second = node("frontend", vec![first.id]);
    let third = node("docs", vec![]);
    let second_id = second.id;
    let first_id = first.id;
    let third_id = third.id;
    let dag = TaskDag::validate(vec![second, third, first]).unwrap();

    assert_eq!(
        dag.ready_tasks(&BTreeSet::new()),
        BTreeSet::from([first_id, third_id])
    );
    let completed = BTreeSet::from([first_id]);
    assert!(dag.can_complete(second_id, &completed));
    assert_eq!(
        dag.ready_tasks(&completed),
        BTreeSet::from([second_id, third_id])
    );
}

#[test]
fn completion_cannot_precede_dependencies() {
    let first = node("backend", vec![]);
    let second = node("frontend", vec![first.id]);
    let second_id = second.id;
    let first_id = first.id;
    let dag = TaskDag::validate(vec![first, second]).unwrap();

    assert!(!dag.can_complete(second_id, &BTreeSet::new()));
    assert!(dag.can_complete(second_id, &BTreeSet::from([first_id])));
}

#[test]
fn dependency_order_serializes_overlapping_write_scopes() {
    let first = node("src/api", vec![]);
    let second = node("src/api/routes.rs", vec![first.id]);

    assert!(TaskDag::validate(vec![first, second]).is_ok());
}
