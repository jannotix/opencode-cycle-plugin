ALTER TABLE workflow_candidates
ADD COLUMN payload_complete INTEGER NOT NULL DEFAULT 0
CHECK (payload_complete IN (0, 1));

CREATE TABLE workflow_candidate_files (
    candidate_id TEXT NOT NULL REFERENCES workflow_candidates(candidate_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content BLOB NOT NULL,
    executable INTEGER NOT NULL CHECK (executable IN (0, 1)),
    PRIMARY KEY (candidate_id, path)
) STRICT;

CREATE TABLE candidate_delivery_reservations (
    candidate_id TEXT PRIMARY KEY REFERENCES workflow_candidates(candidate_id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL UNIQUE REFERENCES workflows(id) ON DELETE CASCADE,
    candidate_digest TEXT NOT NULL,
    journal_digest TEXT,
    started_at TEXT NOT NULL
) STRICT;

INSERT INTO schema_history(version) VALUES (16);
