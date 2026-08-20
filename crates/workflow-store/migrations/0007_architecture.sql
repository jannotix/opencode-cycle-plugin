CREATE TABLE workflow_architecture (
    workflow_id TEXT PRIMARY KEY REFERENCES workflow_requests(workflow_id) ON DELETE CASCADE,
    request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
    plan_digest TEXT NOT NULL CHECK(length(plan_digest) = 64),
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

INSERT INTO schema_history(version) VALUES (7);
