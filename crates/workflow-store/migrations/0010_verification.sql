CREATE TABLE workflow_verification_plans (
    plan_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX workflow_verification_plans_workflow
ON workflow_verification_plans(workflow_id, created_at, plan_id);

CREATE TABLE workflow_evidence (
    evidence_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES workflow_verification_plans(plan_id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES workflow_candidates(candidate_id) ON DELETE CASCADE,
    mandatory INTEGER NOT NULL CHECK(mandatory IN (0, 1)),
    record_json TEXT NOT NULL,
    output_redacted TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX workflow_evidence_candidate
ON workflow_evidence(candidate_id, evidence_id);

INSERT INTO schema_history(version) VALUES (10);
