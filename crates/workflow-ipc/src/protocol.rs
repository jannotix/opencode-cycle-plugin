use serde::{Deserialize, Serialize};
use workflow_core::{
    CandidateId, CandidateManifest, ContentDigest, EvidenceId, EvidenceRecord, GoalId,
    ProtocolEnvelope, ReceiptId, UserRoutingPreference, VerificationPlanId, WorkflowId,
    WorkflowMode,
};

use crate::audit::AuditObservation;
use crate::auth::{Challenge, ChallengeResponse};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum HistoryOperation {
    Export,
    Query {
        after_sequence: Option<u64>,
        limit: usize,
    },
    Verify,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum MemoryOperation {
    Explain {
        memory_id: workflow_core::MemoryId,
    },
    Remove {
        memory_id: workflow_core::MemoryId,
    },
    Search {
        confidence: Option<String>,
        limit: usize,
        scope: Option<String>,
        text: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlOperation {
    Cancel,
    Doctor,
    Evidence,
    Pause,
    Recovery,
    Resume,
    Retry,
    Status,
    Tasks,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionOperation {
    Acquire,
    Release,
    Renew,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOutcome {
    Blocked,
    PlanDefect,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalControlAction {
    StartPlanning,
    MarkReady,
    Activate,
    Pause,
    Resume,
    Block,
    ResumeBlocked,
    Continue,
    RequestCompletion,
    ApproveCompletion,
    RejectCompletion,
    Abort,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum GoalOperation {
    Create {
        constraints: Vec<String>,
        goal_id: GoalId,
        max_continuations: u8,
        non_goals: Vec<String>,
        objective: String,
        session_id: String,
        success_criteria: Vec<String>,
    },
    Amend {
        goal_id: GoalId,
        operation_id: ReceiptId,
        text: String,
    },
    Control {
        action: GoalControlAction,
        completion_evidence: Option<ContentDigest>,
        goal_id: GoalId,
        operation_id: ReceiptId,
        reason: Option<String>,
    },
    Focus {
        goal_id: GoalId,
        session_id: String,
    },
    LinkWorkflow {
        goal_id: GoalId,
        milestone: String,
        workflow_id: WorkflowId,
    },
    List {},
    SavePlan {
        content: String,
        goal_id: GoalId,
        source_session_id: String,
    },
    Status {
        goal_id: Option<GoalId>,
        session_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum ClientMessage {
    Authenticate(ChallengeResponse),
    Admission {
        operation: AdmissionOperation,
        project_key: String,
        request_id: u64,
        workflow_id: WorkflowId,
        workspace: String,
    },
    Audit {
        request_id: u64,
        observation: AuditObservation,
    },
    CodeIndex {
        project_directory: String,
        project_key: String,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    Control {
        operation: ControlOperation,
        operation_id: ReceiptId,
        project_key: String,
        request_id: u64,
        workflow_id: Option<WorkflowId>,
    },
    SubmitArbitration {
        candidate_id: CandidateId,
        project_key: String,
        request_id: u64,
        verdict: workflow_core::ArbiterVerdict,
        workflow_id: WorkflowId,
    },
    Health {
        request_id: u64,
    },
    FreezeCandidate {
        base_revision: String,
        candidate_id: CandidateId,
        evidence_ids: Vec<EvidenceId>,
        plan_id: VerificationPlanId,
        project_key: String,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    Goal {
        operation: GoalOperation,
        project_key: String,
        request_id: u64,
    },
    History {
        operation: HistoryOperation,
        project_key: String,
        request_id: u64,
    },
    Memory {
        operation: MemoryOperation,
        project_key: String,
        request_id: u64,
    },
    PlanVerification {
        plan_id: VerificationPlanId,
        project_key: String,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    PromoteCandidate {
        candidate_id: CandidateId,
        project_directory: String,
        project_key: String,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    ReportExecution {
        outcome: ExecutionOutcome,
        project_key: String,
        report_id: ReceiptId,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    Request(IpcRequest),
    SubmitReview {
        candidate_id: CandidateId,
        project_key: String,
        request_id: u64,
        verdict: workflow_core::ReviewVerdict,
        workflow_id: WorkflowId,
    },
    VerifyCandidate {
        #[serde(default)]
        attestations: Vec<ManagedBrowserAttestation>,
        candidate_id: CandidateId,
        plan_id: VerificationPlanId,
        project_key: String,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    Worktree {
        project_directory: String,
        project_key: String,
        request_id: u64,
        workflow_id: WorkflowId,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum ServerMessage {
    Admission {
        request_id: u64,
        result: serde_json::Value,
    },
    ArbitrationRecorded {
        decision: workflow_core::ArbiterDecision,
        receipt: Box<workflow_core::ArbitrationReceipt>,
        receipt_digest: ContentDigest,
        request_id: u64,
        workflow_id: WorkflowId,
        workflow_state: String,
    },
    Challenge(Challenge),
    CandidateFrozen {
        candidate_digest: ContentDigest,
        candidate_id: CandidateId,
        manifest: Box<CandidateManifest>,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    CodeIndex {
        request_id: u64,
        result: serde_json::Value,
    },
    Control {
        request_id: u64,
        result: serde_json::Value,
    },
    Goal {
        request_id: u64,
        result: serde_json::Value,
    },
    AuditRecorded {
        entry_hash: String,
        request_id: u64,
        sequence: u64,
    },
    Health {
        request_id: u64,
        report: HealthReport,
    },
    History {
        request_id: u64,
        result: serde_json::Value,
    },
    Memory {
        request_id: u64,
        result: serde_json::Value,
    },
    CandidatePromoted {
        changed_paths: Vec<String>,
        request_id: u64,
        workflow_id: WorkflowId,
        workflow_state: String,
    },
    Response(IpcResponse),
    ReviewRecorded {
        candidate_id: CandidateId,
        request_id: u64,
        reviews_ready: bool,
        workflow_id: WorkflowId,
    },
    ExecutionReported {
        request_id: u64,
        workflow_id: WorkflowId,
        workflow_state: String,
    },
    VerificationCompleted {
        candidate_id: CandidateId,
        evidence: Vec<VerificationEvidence>,
        mandatory_passed: bool,
        request_id: u64,
        workflow_id: WorkflowId,
        workflow_state: String,
    },
    VerificationPlanned {
        evidence_ids: Vec<EvidenceId>,
        plan_id: VerificationPlanId,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    Worktree {
        base_revision: String,
        path: String,
        request_id: u64,
        workflow_id: WorkflowId,
    },
    Error {
        request_id: Option<u64>,
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationEvidence {
    pub output: String,
    pub record: EvidenceRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedBrowserAttestation {
    pub candidate_digest: ContentDigest,
    pub receipt_digest: ContentDigest,
    pub receipt_json: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HealthReport {
    pub product_version: String,
    pub protocol_version: u16,
    pub schema_mode: String,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IpcRequest {
    pub affected_paths: Vec<String>,
    pub critical_downgrade_approval: Option<ReceiptId>,
    pub project_key: String,
    pub request_id: u64,
    pub routing_preference: UserRoutingPreference,
    pub workflow_id: Option<WorkflowId>,
    pub envelope: ProtocolEnvelope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum IpcResponse {
    Accepted {
        mode: WorkflowMode,
        request_digest: ContentDigest,
        request_id: u64,
        workflow_id: WorkflowId,
        envelope: Box<ProtocolEnvelope>,
    },
    Rejected {
        request_id: u64,
        code: String,
        message: String,
    },
}
