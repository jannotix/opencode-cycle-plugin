export {
  ControlPlaneError,
  LocalControlPlane,
  resolveDataDirectory,
  type AuditObservation,
  type AuditReceipt,
  type ArchitecturePlanInput,
  type AdmissionOperation,
  type AdmissionReceipt,
  type CodeIndexReceipt,
  type ControlOperation,
  type GoalControlAction,
  type GoalOperation,
  type HistoryOperation,
  type MemoryOperation,
  type OwnedProcessIdentity,
  type PromotionReceipt,
  type TaskClosureReceipt,
  type TaskClosureReportInput,
  type WorkflowStartReceipt,
  type WorkflowStartRequest,
} from "./client.js"

export interface WorkflowControlPlane {
  admission(
    projectKey: string,
    workflowId: string,
    workspace: string,
    operation: import("./client.js").AdmissionOperation,
  ): Promise<import("./client.js").AdmissionReceipt>
  codeIndex(
    projectKey: string,
    workflowId: string,
    projectDirectory: string,
  ): Promise<import("./client.js").CodeIndexReceipt>
  audit(observation: import("./client.js").AuditObservation): Promise<import("./client.js").AuditReceipt>
  control(
    projectKey: string,
    operation: import("./client.js").ControlOperation,
    workflowId?: string,
  ): Promise<unknown>
  goal(projectKey: string, operation: import("./client.js").GoalOperation): Promise<unknown>
  history(projectKey: string, operation: import("./client.js").HistoryOperation): Promise<unknown>
  memory(projectKey: string, operation: import("./client.js").MemoryOperation): Promise<unknown>
  promoteCandidate(
    projectKey: string,
    workflowId: string,
    candidateId: string,
    projectDirectory: string,
  ): Promise<import("./client.js").PromotionReceipt>
  startWorkflow(
    request: import("./client.js").WorkflowStartRequest,
  ): Promise<import("./client.js").WorkflowStartReceipt>
  submitArchitecture(
    projectKey: string,
    workflowId: string,
    plan: import("./client.js").ArchitecturePlanInput,
  ): Promise<void>
  reportTaskClosure(
    projectKey: string,
    workflowId: string,
    report: import("./client.js").TaskClosureReportInput,
  ): Promise<import("./client.js").TaskClosureReceipt>
  dispose(): Promise<void>
  health(): Promise<import("./client.js").ControlPlaneHealth>
}
