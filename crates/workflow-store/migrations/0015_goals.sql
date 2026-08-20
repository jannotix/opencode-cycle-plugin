CREATE TABLE goals (
    goal_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    goal_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX goals_project ON goals(project_id, updated_at DESC, goal_id);

CREATE TABLE goal_focus (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, session_id)
) STRICT;

CREATE TABLE goal_plans (
    goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    source_session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_digest TEXT NOT NULL CHECK(length(content_digest) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY(goal_id, revision),
    UNIQUE(goal_id, content_digest)
) STRICT;

CREATE TABLE goal_workflows (
    goal_id TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
    milestone TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY(goal_id, workflow_id),
    UNIQUE(workflow_id)
) STRICT;

INSERT INTO schema_history(version) VALUES (15);
