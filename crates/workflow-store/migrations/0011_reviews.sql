CREATE TABLE workflow_reviews (
    candidate_id TEXT NOT NULL REFERENCES workflow_candidates(candidate_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('functional_reviewer', 'security_architecture_reviewer')),
    verdict_json TEXT NOT NULL,
    finalized_at TEXT NOT NULL,
    PRIMARY KEY(candidate_id, role)
) STRICT;

INSERT INTO schema_history(version) VALUES (11);
