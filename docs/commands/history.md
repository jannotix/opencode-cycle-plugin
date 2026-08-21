# History Commands

Cycle for OpenCode captures activity observed in a Cycle session automatically. No dashboard or separate interface is installed.

## `/cycle history`

Returns the current project's redacted ledger events in ascending global sequence order. Results are paginated; the default page size is 100 and the maximum is 1,000. A returned `next_sequence` is the cursor for the next request.

## `/cycle history verify`

Recomputes the complete hash chain and verifies every stored Ed25519 checkpoint against the installation key. The result distinguishes an invalid chain, head mismatch, missing key, replaced key, malformed public key, and invalid signature.

The daemon also performs this verification before accepting connections. Startup fails closed when existing history or a checkpoint cannot be verified.

## `/cycle export --confirm`

Exports the canonical ledger and public checkpoint material. Export is never automatic and requires explicit confirmation. Signing seeds, IPC credentials, raw prompts, raw tool output, and secret contents are excluded.

The ledger uses one global sequence across local projects. A full export therefore contains the global audit chain. Store or transmit it only as deliberately as any other project artifact.

## Trust boundary

Verification is relative to the local installation key and trusted checkpoint copies. A machine administrator can control both local data and local keys; copy checkpoints to an independently controlled system when stronger assurance is required. See [Ledger Trust Boundary](../security/ledger-trust.md).
