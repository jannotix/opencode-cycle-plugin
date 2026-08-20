CREATE TABLE workflow_arbitration (
    candidate_id TEXT PRIMARY KEY REFERENCES workflow_candidates(candidate_id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    verdict_json TEXT NOT NULL,
    receipt_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    finalized_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX workflow_arbitration_receipt
ON workflow_arbitration(receipt_digest);

INSERT INTO schema_history(version) VALUES (12);
