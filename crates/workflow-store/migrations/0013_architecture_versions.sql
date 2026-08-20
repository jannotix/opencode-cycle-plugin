CREATE TABLE workflow_architecture_versions (
    workflow_id TEXT NOT NULL REFERENCES workflow_requests(workflow_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    request_digest TEXT NOT NULL,
    plan_digest TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workflow_id, revision)
) STRICT;

INSERT INTO workflow_architecture_versions(
    workflow_id, revision, request_digest, plan_digest, plan_json, created_at
)
SELECT workflow_id, 1, request_digest, plan_digest, plan_json, created_at
FROM workflow_architecture;

INSERT INTO schema_history(version) VALUES (13);
