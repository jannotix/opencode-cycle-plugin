# Threat Model

## Protected assets

- the immutable original user request and amendments;
- project source, managed worktrees and approved candidate identity;
- provider credentials owned by OpenCode;
- workflow state, evidence, project memory and history;
- IPC credentials and ledger signing keys;
- release packages, checksums, SBOM and certification evidence.

## Trust boundaries

OpenCode owns provider authentication, native permissions and user interaction. The TypeScript plugin is an in-process adapter. `workflowd` is a same-user local process reached only through an authenticated named pipe or Unix socket. Project files, model output, websites, terminal output, MCP results and dependency metadata are untrusted inputs. The machine administrator and a malicious process already running as the same operating-system user are inside the local machine-owner boundary.

## Primary threats and controls

| Threat | Control |
| --- | --- |
| Executor self-approval or correlated model error | Isolated architect, executor, two reviewers and arbiter sessions; deterministic gates; no executor verdict. |
| Requirement drift | Immutable intake digest; arbiter receives the original request directly with exact candidate and evidence. |
| Reviewer contamination | Reviewers run independently and cannot read each other's verdict before finalization. |
| Prompt injection from repository or tools | Role prompts treat all retrieved content as data; native permissions remain authoritative. |
| Candidate mutation after review | Candidate freeze binds diff, files, configuration, dependencies, environment and evidence; mutation invalidates review. |
| Overwrite of unrelated user work | Managed worktree execution and conflict-aware exact-diff promotion. |
| Local IPC spoofing or replay | Same-user endpoint controls, random 256-bit secret, nonce challenge, HMAC-SHA-256, expiry and replay cache. |
| Oversized or malformed IPC input | Versioned length-prefixed framing, 8 MiB limit, strict fields and poisoned decoder after failure. |
| History tampering | Canonical append-only hash chain and Ed25519 checkpoints verified before serving. |
| Secret leakage to context or records | Credentials remain in OpenCode; audit and evidence retain identifiers, digests and bounded redacted output. |
| Resource exhaustion | Global fair admission, CPU/RAM/disk reserves, leases, bounded parsers and graph queries, single large-index gate. |
| Supply-chain substitution | Locked dependencies, allowlisted archives, per-platform native packages, checksums, SBOM, provenance and exact Desktop asset digests/signatures. |
| Host update incompatibility | Stable public API only, startup capability negotiation, inert safe mode and data outside the application installation. |

## Residual risks

Independent sessions reduce but cannot eliminate correlated errors when roles use the same model family. A compromised same-user process can access that user's project and application data. Local signed history is not an external transparency log; a machine administrator who replaces both keys and records can rewrite local trust. Project verification is only as strong as the real tools, test data and environments available under the user's permissions. These limits are reported and never converted into a passing gate automatically.

Report suspected vulnerabilities through the private process in [SECURITY.md](../../SECURITY.md).
