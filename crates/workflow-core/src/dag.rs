use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{TaskId, WorkflowRole, path};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskNode {
    pub id: TaskId,
    pub owner: WorkflowRole,
    pub write_scopes: Vec<String>,
    pub dependencies: Vec<TaskId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DagError {
    Empty,
    DuplicateTask {
        task_id: TaskId,
    },
    InvalidOwner {
        task_id: TaskId,
    },
    InvalidScope {
        task_id: TaskId,
        scope: String,
    },
    OverlappingScope {
        first_task: TaskId,
        second_task: TaskId,
        first_scope: String,
        second_scope: String,
    },
    DuplicateDependency {
        task_id: TaskId,
        dependency: TaskId,
    },
    MissingDependency {
        task_id: TaskId,
        dependency: TaskId,
    },
    Cycle,
}

impl std::fmt::Display for DagError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => formatter.write_str("the task graph is empty"),
            Self::DuplicateTask { task_id } => write!(formatter, "duplicate task {task_id}"),
            Self::InvalidOwner { task_id } => {
                write!(formatter, "task {task_id} has an invalid owner")
            }
            Self::InvalidScope { task_id, scope } => {
                write!(formatter, "task {task_id} has invalid scope {scope:?}")
            }
            Self::OverlappingScope {
                first_task,
                second_task,
                first_scope,
                second_scope,
            } => write!(
                formatter,
                "task {first_task} scope {first_scope:?} overlaps task {second_task} scope {second_scope:?}"
            ),
            Self::DuplicateDependency {
                task_id,
                dependency,
            } => write!(formatter, "task {task_id} repeats dependency {dependency}"),
            Self::MissingDependency {
                task_id,
                dependency,
            } => write!(
                formatter,
                "task {task_id} depends on missing task {dependency}"
            ),
            Self::Cycle => formatter.write_str("the task graph contains a cycle"),
        }
    }
}

impl std::error::Error for DagError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TaskDag {
    nodes: BTreeMap<TaskId, TaskNode>,
    topological_order: Vec<TaskId>,
}

impl TaskDag {
    pub fn validate(nodes: Vec<TaskNode>) -> Result<Self, DagError> {
        if nodes.is_empty() {
            return Err(DagError::Empty);
        }

        let mut indexed = BTreeMap::new();
        for node in nodes {
            let task_id = node.id;
            if indexed.insert(task_id, node).is_some() {
                return Err(DagError::DuplicateTask { task_id });
            }
        }

        Self::validate_nodes(&indexed)?;
        let topological_order = Self::sort(&indexed)?;
        Ok(Self {
            nodes: indexed,
            topological_order,
        })
    }

    #[must_use]
    pub fn topological_order(&self) -> Vec<TaskId> {
        self.topological_order.clone()
    }

    #[must_use]
    pub fn ready_tasks(&self, completed: &BTreeSet<TaskId>) -> BTreeSet<TaskId> {
        self.nodes
            .values()
            .filter(|node| {
                !completed.contains(&node.id)
                    && node
                        .dependencies
                        .iter()
                        .all(|dependency| completed.contains(dependency))
            })
            .map(|node| node.id)
            .collect()
    }

    #[must_use]
    pub fn can_complete(&self, task_id: TaskId, completed: &BTreeSet<TaskId>) -> bool {
        !completed.contains(&task_id)
            && self.nodes.get(&task_id).is_some_and(|node| {
                node.dependencies
                    .iter()
                    .all(|dependency| completed.contains(dependency))
            })
    }

    #[must_use]
    pub fn dependencies(&self, task_id: TaskId) -> Option<&[TaskId]> {
        self.nodes
            .get(&task_id)
            .map(|node| node.dependencies.as_slice())
    }

    fn validate_nodes(nodes: &BTreeMap<TaskId, TaskNode>) -> Result<(), DagError> {
        for node in nodes.values() {
            if node.owner != WorkflowRole::Executor {
                return Err(DagError::InvalidOwner { task_id: node.id });
            }
            if node.write_scopes.is_empty() {
                return Err(DagError::InvalidScope {
                    task_id: node.id,
                    scope: String::new(),
                });
            }
            for scope in &node.write_scopes {
                if !path::is_safe_relative(scope) {
                    return Err(DagError::InvalidScope {
                        task_id: node.id,
                        scope: scope.clone(),
                    });
                }
            }

            let mut dependencies = BTreeSet::new();
            for dependency in &node.dependencies {
                if !dependencies.insert(*dependency) {
                    return Err(DagError::DuplicateDependency {
                        task_id: node.id,
                        dependency: *dependency,
                    });
                }
                if !nodes.contains_key(dependency) {
                    return Err(DagError::MissingDependency {
                        task_id: node.id,
                        dependency: *dependency,
                    });
                }
            }
        }
        let mut scopes = Vec::<(TaskId, String)>::new();
        for node in nodes.values() {
            for scope in &node.write_scopes {
                for (other_task, other_scope) in &scopes {
                    if path::overlaps(scope, other_scope)
                        && !dependency_ordered(nodes, node.id, *other_task)
                    {
                        return Err(DagError::OverlappingScope {
                            first_task: *other_task,
                            second_task: node.id,
                            first_scope: other_scope.clone(),
                            second_scope: scope.clone(),
                        });
                    }
                }
                scopes.push((node.id, scope.clone()));
            }
        }
        Ok(())
    }

    fn sort(nodes: &BTreeMap<TaskId, TaskNode>) -> Result<Vec<TaskId>, DagError> {
        let mut indegrees = nodes
            .values()
            .map(|node| (node.id, node.dependencies.len()))
            .collect::<BTreeMap<_, _>>();
        let mut dependents = BTreeMap::<TaskId, Vec<TaskId>>::new();
        for node in nodes.values() {
            for dependency in &node.dependencies {
                dependents.entry(*dependency).or_default().push(node.id);
            }
        }
        let mut ready = indegrees
            .iter()
            .filter_map(|(id, degree)| (*degree == 0).then_some(*id))
            .collect::<BTreeSet<_>>();
        let mut order = Vec::with_capacity(nodes.len());

        while let Some(task_id) = ready.pop_first() {
            order.push(task_id);
            for dependent in dependents.get(&task_id).into_iter().flatten() {
                let degree = indegrees
                    .get_mut(dependent)
                    .expect("validated dependent must exist");
                *degree -= 1;
                if *degree == 0 {
                    ready.insert(*dependent);
                }
            }
        }

        if order.len() == nodes.len() {
            Ok(order)
        } else {
            Err(DagError::Cycle)
        }
    }
}

fn dependency_ordered(nodes: &BTreeMap<TaskId, TaskNode>, first: TaskId, second: TaskId) -> bool {
    depends_on(nodes, first, second) || depends_on(nodes, second, first)
}

fn depends_on(nodes: &BTreeMap<TaskId, TaskNode>, task: TaskId, target: TaskId) -> bool {
    let mut pending = vec![task];
    let mut visited = BTreeSet::new();
    while let Some(current) = pending.pop() {
        if !visited.insert(current) {
            continue;
        }
        for dependency in nodes
            .get(&current)
            .into_iter()
            .flat_map(|node| &node.dependencies)
        {
            if *dependency == target {
                return true;
            }
            pending.push(*dependency);
        }
    }
    false
}
