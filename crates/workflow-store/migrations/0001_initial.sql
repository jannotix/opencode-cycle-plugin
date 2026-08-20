CREATE TABLE schema_history (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO schema_history(version) VALUES (1);

CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_aggregate ON events(aggregate_type, aggregate_id, sequence);

CREATE TABLE command_deduplication (
    idempotency_key TEXT PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
