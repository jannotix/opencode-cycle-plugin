# Code Intelligence

Code intelligence is a mandatory local component of Cycle for OpenCode. It provides bounded project context without repeatedly sending or scanning an entire repository.

## Initial index

The control plane inventories files with Git-compatible ignore rules, excludes ignored and vendor content, rejects symlink escapes, hashes supported sources in parallel, parses them with pinned Tree-sitter grammars, and persists graph partitions in SQLite. Each node and relation records source path, range, provenance and confidence. Unsupported files receive only a digest and exact-text fallback; they never receive invented semantic relationships.

The first index is the expensive pass. A manifest binds paths and content hashes to the repository and Git fingerprint. Later workflows reuse unchanged partitions. Modified and added files replace only their affected partition data; deleted and renamed files remove stale nodes before new data becomes visible. Partition updates are atomic.

## Query behavior

Architect context is selected from bounded graph searches and FTS path lookup. Queries have byte, item, node, edge and traversal limits and report truncation explicitly. Broad project facts remain in the local database rather than model context. Verification receives direct project commands and paths, not a model-generated substitute for the codebase.

## Large repositories

Index construction uses bounded parallel hashing and parsing with serial atomic persistence. Only one large index is admitted globally, and indexing yields when verification is waiting. The release benchmark creates more than 500,000 parseable source files plus ignored files, verifies parsing and persistence, performs a bounded graph query, then proves incremental modification, rename and deletion behavior.

## Supported syntax

See [Supported Languages](supported-languages.md) for the certified adapters and explicit fallback behavior. A language adapter is evidence about syntax, not proof of buildability, runtime behavior, type correctness or security; those facts require the project's real verification tools.
