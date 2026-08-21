use std::collections::BTreeMap;

use workflow_core::{TaskDag, TaskId, TaskNode, WorkflowRole};

#[test]
fn every_topological_order_places_dependencies_first() {
    let ids = [TaskId::new(), TaskId::new(), TaskId::new(), TaskId::new()];
    let nodes = vec![
        TaskNode {
            id: ids[0],
            owner: WorkflowRole::Executor,
            write_scopes: vec!["a".to_owned()],
            dependencies: vec![],
        },
        TaskNode {
            id: ids[1],
            owner: WorkflowRole::Executor,
            write_scopes: vec!["b".to_owned()],
            dependencies: vec![ids[0]],
        },
        TaskNode {
            id: ids[2],
            owner: WorkflowRole::Executor,
            write_scopes: vec!["c".to_owned()],
            dependencies: vec![ids[0]],
        },
        TaskNode {
            id: ids[3],
            owner: WorkflowRole::Executor,
            write_scopes: vec!["d".to_owned()],
            dependencies: vec![ids[1], ids[2]],
        },
    ];
    let dag = TaskDag::validate(nodes).unwrap();
    let order = dag.topological_order();
    let positions = order
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect::<BTreeMap<_, _>>();

    for id in order {
        for dependency in dag.dependencies(id).unwrap() {
            assert!(positions[dependency] < positions[&id]);
        }
    }
}
