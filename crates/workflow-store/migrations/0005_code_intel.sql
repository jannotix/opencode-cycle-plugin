CREATE TABLE code_partitions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    head_generation INTEGER NOT NULL CHECK(head_generation >= 1),
    updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX code_partition_scope ON code_partitions(project_id, scope);

CREATE TABLE code_nodes (
    partition_id TEXT NOT NULL REFERENCES code_partitions(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    id TEXT NOT NULL,
    node_json TEXT NOT NULL,
    PRIMARY KEY(partition_id, generation, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX code_nodes_id ON code_nodes(id, partition_id, generation);

CREATE TABLE code_edges (
    partition_id TEXT NOT NULL REFERENCES code_partitions(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    edge_json TEXT NOT NULL,
    PRIMARY KEY(partition_id, generation, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX code_edges_source ON code_edges(source_id, partition_id, generation);
CREATE INDEX code_edges_target ON code_edges(target_id, partition_id, generation);

CREATE TABLE code_manifest (
    project_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    length INTEGER NOT NULL CHECK(length >= 0),
    modified_unix_nanos TEXT,
    content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
    entry_json TEXT NOT NULL,
    PRIMARY KEY(project_id, relative_path)
) STRICT, WITHOUT ROWID;

INSERT INTO schema_history(version) VALUES (5);
