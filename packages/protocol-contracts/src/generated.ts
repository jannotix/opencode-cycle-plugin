export type ProtocolPayload =
  | {
      data: RequestRecord
      type: "request"
    }
  | {
      data: ArchitecturePlan
      type: "architecture"
    }
  | {
      data: CandidateManifest
      type: "candidate"
    }
  | {
      data: EvidenceRecord
      type: "evidence"
    }
  | {
      data: ArbiterVerdict
      type: "verdict"
    }
export type CandidateFileKind = "added" | "deleted" | "generated" | "modified"
export type EvidenceKind =
  "command" | "test" | "build" | "lint" | "database" | "browser" | "security" | "inspection" | "package"
export type EvidenceStatus = "passed" | "failed" | "skipped"
export type ArbiterDecision = "approved" | "rejected"
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info"
export type RepairTarget = "execution" | "architecture"
export type RequirementStatus = "satisfied" | "unsatisfied"

export interface ProtocolEnvelope {
  payload: ProtocolPayload
  version: number
}
export interface RequestRecord {
  amendments: RequestAmendment[]
  attachment_hashes: string[]
  original_text: string
}
export interface RequestAmendment {
  received_at: string
  sequence: number
  text: string
}
export interface ArchitecturePlan {
  assumptions: string[]
  integration_checks: string[]
  request_digest: string
  requirements: Requirement[]
  risks: string[]
  tasks: PlannedTask[]
}
export interface Requirement {
  acceptance_criteria: string[]
  id: string
  statement: string
}
export interface PlannedTask {
  acceptance_criteria: string[]
  dependencies: string[]
  id: string
  objective: string
  requirement_ids: string[]
  title: string
  verification_commands: string[]
  write_scopes: string[]
}
export interface CandidateManifest {
  base_revision?: string | null
  candidate_id: string
  configuration_digest: string
  delivery_payload_digest?: string | null
  dependency_state_digest: string
  diff_digest: string
  environment_digest: string
  evidence_ids: string[]
  files: CandidateFile[]
}
export interface CandidateFile {
  digest?: string | null
  executable?: boolean
  kind: CandidateFileKind
  path: string
}
export interface EvidenceRecord {
  candidate_digest: string
  exit_code?: number | null
  finished_at: string
  id: string
  invocation: string
  kind: EvidenceKind
  output_digest: string
  skip_reason?: string | null
  started_at: string
  status: EvidenceStatus
  tool: string
  tool_version: string
}
export interface ArbiterVerdict {
  candidate_digest: string
  decision: ArbiterDecision
  findings: Finding[]
  repair_target?: RepairTarget | null
  requirements: RequirementDecision[]
}
export interface Finding {
  evidence_ids: string[]
  severity: FindingSeverity
  summary: string
}
export interface RequirementDecision {
  evidence_ids: string[]
  requirement_id: string
  status: RequirementStatus
}
