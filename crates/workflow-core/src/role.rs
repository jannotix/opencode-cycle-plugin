use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRole {
    Architect,
    Executor,
    FunctionalReviewer,
    SecurityArchitectureReviewer,
    Arbiter,
}
