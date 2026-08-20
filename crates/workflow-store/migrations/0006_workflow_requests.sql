CREATE TABLE workflow_requests (
    workflow_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX workflow_requests_project ON workflow_requests(project_id, created_at);

INSERT INTO schema_history(version) VALUES (6);
