CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK(confidence IN ('inferred', 'user_asserted', 'verified')),
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('current', 'revoked', 'superseded')),
    actor TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL,
    superseded_by TEXT REFERENCES memory_entries(id),
    entry_json TEXT NOT NULL
) STRICT;

CREATE INDEX memory_project_state_time
    ON memory_entries(project_id, state, created_at DESC);

CREATE TABLE memory_scopes (
    memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    PRIMARY KEY(memory_id, scope)
) STRICT, WITHOUT ROWID;

CREATE INDEX memory_scope ON memory_scopes(scope, memory_id);

CREATE TABLE memory_sources (
    memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES ledger_entries(event_id),
    PRIMARY KEY(memory_id, event_id)
) STRICT, WITHOUT ROWID;

CREATE VIRTUAL TABLE memory_fts USING fts5(
    id UNINDEXED,
    title,
    summary,
    detail,
    tokenize = "unicode61 tokenchars '_-.:/'"
);

INSERT INTO schema_history(version) VALUES (4);
