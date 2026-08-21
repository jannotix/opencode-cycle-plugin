# Ledger Trust Boundary

Cycle for OpenCode records observed workflow activity in a canonical, append-only hash chain. Each entry commits to its sequence number, previous entry hash, and redacted event bytes. Ed25519 checkpoints bind a selected chain head to the local installation key.

Verification detects mutation, insertion, deletion, reordering, and truncation relative to a trusted checkpoint. A checkpoint reports missing key material, an unexpected key, an invalid signature, and a mismatched chain head as distinct failures.

The daemon signs the first entry and every hundredth entry. It verifies the full chain, all stored checkpoints, and the current installation key before accepting connections. The ledger is not an external transparency service. A machine administrator who controls the application data and signing key can replace both. Stronger assurance requires copying signed checkpoints to an independently controlled system.

The write boundary removes configured sensitive metadata and recognized credential forms. The ledger stores identifiers, normalized actions, paths, digests, decisions, and outcomes. It does not store signing seeds, raw credentials, secret file contents, full tool output, or unnecessary source content.

Actions observed through Cycle for OpenCode receive workflow attribution. File or Git changes detected outside the workflow are attributed to `external_unknown` unless reliable metadata proves a more specific actor.
