CREATE TABLE workflow_constraints (
    workflow_id TEXT NOT NULL REFERENCES workflow_requests(workflow_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    constraint_digest TEXT NOT NULL CHECK(length(constraint_digest) = 64),
    constraint_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workflow_id, kind)
) STRICT, WITHOUT ROWID;

INSERT INTO schema_history(version) VALUES (8);
