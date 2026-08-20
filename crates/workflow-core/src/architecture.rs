use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{ContentDigest, DagError, TaskDag, TaskId, TaskNode, WorkflowRole};

const MAX_ITEMS: usize = 256;
const MAX_TEXT_BYTES: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub acceptance_criteria: Vec<String>,
    pub id: String,
    pub statement: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct PlannedTask {
    pub acceptance_criteria: Vec<String>,
    pub dependencies: Vec<TaskId>,
    pub id: TaskId,
    pub objective: String,
    pub requirement_ids: Vec<String>,
    pub title: String,
    pub verification_commands: Vec<String>,
    pub write_scopes: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ArchitecturePlan {
    pub assumptions: Vec<String>,
    pub integration_checks: Vec<String>,
    pub request_digest: ContentDigest,
    pub requirements: Vec<Requirement>,
    pub risks: Vec<String>,
    pub tasks: Vec<PlannedTask>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UncheckedPlan {
    assumptions: Vec<String>,
    integration_checks: Vec<String>,
    request_digest: ContentDigest,
    requirements: Vec<Requirement>,
    risks: Vec<String>,
    tasks: Vec<PlannedTask>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArchitectureError {
    Dag(DagError),
    EmptyAcceptanceCriteria,
    EmptyIntegrationChecks,
    InvalidRequirement,
    InvalidTask,
    LimitExceeded,
    MissingRequirementCoverage(String),
    UnknownRequirement(String),
}

impl std::fmt::Display for ArchitectureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Dag(error) => error.fmt(formatter),
            Self::EmptyAcceptanceCriteria => {
                formatter.write_str("requirements and tasks need concrete acceptance criteria")
            }
            Self::EmptyIntegrationChecks => {
                formatter.write_str("the architecture plan needs end-to-end integration checks")
            }
            Self::InvalidRequirement => {
                formatter.write_str("requirement identifiers and statements must be bounded")
            }
            Self::InvalidTask => {
                formatter.write_str("task titles, objectives and verification must be bounded")
            }
            Self::LimitExceeded => formatter.write_str("architecture plan exceeds its item limit"),
            Self::MissingRequirementCoverage(id) => {
                write!(formatter, "requirement {id:?} is not covered by any task")
            }
            Self::UnknownRequirement(id) => {
                write!(formatter, "task references unknown requirement {id:?}")
            }
        }
    }
}

impl std::error::Error for ArchitectureError {}

impl ArchitecturePlan {
    pub fn validate(
        request_digest: ContentDigest,
        requirements: Vec<Requirement>,
        tasks: Vec<PlannedTask>,
        assumptions: Vec<String>,
        risks: Vec<String>,
        integration_checks: Vec<String>,
    ) -> Result<Self, ArchitectureError> {
        if requirements.is_empty()
            || requirements.len() > MAX_ITEMS
            || tasks.is_empty()
            || tasks.len() > MAX_ITEMS
            || assumptions.len() > MAX_ITEMS
            || risks.len() > MAX_ITEMS
            || integration_checks.len() > MAX_ITEMS
        {
            return Err(ArchitectureError::LimitExceeded);
        }
        validate_texts(&assumptions)?;
        validate_texts(&risks)?;
        if integration_checks.is_empty() {
            return Err(ArchitectureError::EmptyIntegrationChecks);
        }
        validate_texts(&integration_checks)?;

        let mut requirement_index = BTreeMap::new();
        for requirement in &requirements {
            if !valid_key(&requirement.id) || !valid_text(&requirement.statement) {
                return Err(ArchitectureError::InvalidRequirement);
            }
            if requirement.acceptance_criteria.is_empty() {
                return Err(ArchitectureError::EmptyAcceptanceCriteria);
            }
            validate_texts(&requirement.acceptance_criteria)?;
            if requirement_index
                .insert(requirement.id.clone(), false)
                .is_some()
            {
                return Err(ArchitectureError::InvalidRequirement);
            }
        }

        let mut dag_nodes = Vec::with_capacity(tasks.len());
        for task in &tasks {
            if !valid_text(&task.title)
                || !valid_text(&task.objective)
                || task.requirement_ids.is_empty()
                || task.verification_commands.is_empty()
            {
                return Err(ArchitectureError::InvalidTask);
            }
            if task.acceptance_criteria.is_empty() {
                return Err(ArchitectureError::EmptyAcceptanceCriteria);
            }
            validate_texts(&task.acceptance_criteria)?;
            validate_texts(&task.verification_commands)?;
            let mut linked = BTreeSet::new();
            for requirement_id in &task.requirement_ids {
                if !linked.insert(requirement_id) {
                    return Err(ArchitectureError::InvalidTask);
                }
                let covered = requirement_index
                    .get_mut(requirement_id)
                    .ok_or_else(|| ArchitectureError::UnknownRequirement(requirement_id.clone()))?;
                *covered = true;
            }
            dag_nodes.push(TaskNode {
                dependencies: task.dependencies.clone(),
                id: task.id,
                owner: WorkflowRole::Executor,
                write_scopes: task.write_scopes.clone(),
            });
        }
        TaskDag::validate(dag_nodes).map_err(ArchitectureError::Dag)?;
        if let Some((id, _)) = requirement_index.iter().find(|(_, covered)| !**covered) {
            return Err(ArchitectureError::MissingRequirementCoverage(id.clone()));
        }
        Ok(Self {
            assumptions,
            integration_checks,
            request_digest,
            requirements,
            risks,
            tasks,
        })
    }

    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        ContentDigest::of(
            &serde_json::to_vec(self).expect("validated architecture plans are serializable"),
        )
    }
}

impl TryFrom<UncheckedPlan> for ArchitecturePlan {
    type Error = ArchitectureError;

    fn try_from(value: UncheckedPlan) -> Result<Self, Self::Error> {
        Self::validate(
            value.request_digest,
            value.requirements,
            value.tasks,
            value.assumptions,
            value.risks,
            value.integration_checks,
        )
    }
}

impl<'de> Deserialize<'de> for ArchitecturePlan {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        UncheckedPlan::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

fn validate_texts(values: &[String]) -> Result<(), ArchitectureError> {
    if values.iter().any(|value| !valid_text(value)) {
        Err(ArchitectureError::InvalidTask)
    } else {
        Ok(())
    }
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_TEXT_BYTES && !value.contains('\0')
}

fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
