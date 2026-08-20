CREATE TABLE ledger_entries (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    workflow_id TEXT,
    task_id TEXT,
    candidate_id TEXT,
    actor_id TEXT NOT NULL,
    role TEXT,
    event_json TEXT NOT NULL,
    previous_hash TEXT CHECK(previous_hash IS NULL OR length(previous_hash) = 64),
    entry_hash TEXT NOT NULL UNIQUE CHECK(length(entry_hash) = 64),
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ledger_project_sequence ON ledger_entries(project_id, sequence);
CREATE INDEX ledger_workflow_sequence ON ledger_entries(workflow_id, sequence);
CREATE INDEX ledger_actor_sequence ON ledger_entries(actor_id, sequence);
CREATE INDEX ledger_time_sequence ON ledger_entries(created_at, sequence);

CREATE TABLE ledger_checkpoints (
    sequence INTEGER PRIMARY KEY REFERENCES ledger_entries(sequence),
    checkpoint_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

INSERT INTO schema_history(version) VALUES (3);
