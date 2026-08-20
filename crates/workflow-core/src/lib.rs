#![forbid(unsafe_code)]

mod architecture;
mod candidate;
mod dag;
mod digest;
mod evidence;
mod goal;
mod id;
mod lease;
mod path;
mod protocol;
mod receipt;
mod request;
mod review;
mod role;
mod routing;
mod task;
mod time;
mod verdict;
mod workflow;

pub use architecture::{ArchitectureError, ArchitecturePlan, PlannedTask, Requirement};
pub use candidate::{
    CandidateDigests, CandidateError, CandidateFile, CandidateFileKind, CandidateManifest,
};
pub use dag::{DagError, TaskDag, TaskNode};
pub use digest::{ContentDigest, DigestParseError};
pub use evidence::{EvidenceKind, EvidenceRecord, EvidenceStatus, EvidenceValidationError};
pub use goal::{Goal, GoalCommand, GoalError, GoalEvent, GoalState};
pub use id::{
    CandidateId, EventId, EvidenceId, GoalId, LeaseId, MemoryId, ProjectId, ReceiptId, SessionId,
    TaskId, VerificationPlanId, WorkflowId,
};
pub use lease::{ActionSafety, Lease, LeaseError, LeaseReconciliation};
pub use protocol::{PROTOCOL_VERSION, ProtocolEnvelope, ProtocolError, ProtocolPayload};
pub use receipt::ArbitrationReceipt;
pub use request::{RequestAmendment, RequestError, RequestRecord};
pub use review::{ReviewDecision, ReviewValidationError, ReviewVerdict};
pub use role::WorkflowRole;
pub use routing::{
    RiskCategory, RiskFact, RiskSource, RoutingDecision, RoutingInput, UserRoutingPreference,
    route_workflow,
};
pub use task::{Task, TaskCommand, TaskEvent, TaskState};
pub use time::WorkflowTimestamp;
pub use verdict::{
    ArbiterDecision, ArbiterVerdict, Finding, FindingSeverity, RequirementDecision,
    RequirementStatus, VerdictValidationError,
};
pub use workflow::{
    RepairTarget, TransitionError, Workflow, WorkflowCommand, WorkflowEvent, WorkflowMode,
    WorkflowState,
};
