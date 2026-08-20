CREATE TABLE leases (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    lease_id TEXT NOT NULL UNIQUE,
    lease_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'uncertain')),
    expires_at_unix_millis INTEGER NOT NULL,
    updated_at_unix_millis INTEGER NOT NULL
) STRICT;

INSERT INTO schema_history(version) VALUES (2);
