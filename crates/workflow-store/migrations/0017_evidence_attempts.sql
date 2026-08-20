CREATE TABLE workflow_evidence_attempts (
    evidence_id TEXT NOT NULL REFERENCES workflow_evidence(evidence_id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    record_json TEXT NOT NULL,
    output_redacted TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (evidence_id, attempt)
) STRICT;

INSERT INTO schema_history(version) VALUES (17);
