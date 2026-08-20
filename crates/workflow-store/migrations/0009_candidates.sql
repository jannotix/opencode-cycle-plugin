CREATE TABLE workflow_candidates (
    candidate_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    manifest_digest TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    exact_diff BLOB NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX workflow_candidates_workflow
ON workflow_candidates(workflow_id, created_at, candidate_id);

INSERT INTO schema_history(version) VALUES (9);
