# Memory Commands

Project memory stores reusable knowledge separately from the event ledger and code graph. Every entry includes a trust class, source event identifiers, evidence identifiers where applicable, scope, author, timestamp, and current state.

## `/cycle memory search`

Searches current entries for the active project with local SQLite FTS5. Optional filters include scope and confidence (`verified`, `user_asserted`, or `inferred`). Results are compact summaries bounded to 100 items and 32 KiB. Full details are not loaded during broad retrieval.

## `/cycle memory explain`

Loads one explicitly selected entry with its complete provenance, evidence links, candidate or revision identity, confidence, scope, and supersession state.

## `/cycle memory remove --confirm`

Revokes one entry after explicit confirmation. Revoked entries are excluded from ordinary retrieval but remain available for audit and explanation. The source ledger is never deleted.

## Automatic capture

Automatic memory candidates are accepted only after verification. They require an approved candidate identity, at least one captured evidence identifier, a ledger source event, an explicit scope, and secret-safe content. Model inference without evidence remains `inferred` and cannot become an approval or project constraint automatically.

Memory is local and uses no vector database or cloud memory service.
