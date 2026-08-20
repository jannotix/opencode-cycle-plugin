CREATE TABLE code_index_state (
    project_id TEXT PRIMARY KEY,
    repository_path TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
    updated_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE code_paths_fts USING fts5(
    project_id UNINDEXED,
    relative_path,
    tokenize = 'unicode61'
);

INSERT INTO schema_history(version) VALUES (14);
