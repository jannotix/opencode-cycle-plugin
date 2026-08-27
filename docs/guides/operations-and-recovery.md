# Operations and Recovery

Normal work requires no command sequence: select `Cycle` and state the desired outcome. The integration captures intake, routes risk, builds bounded context, creates an isolated worktree, runs roles and verification, freezes the candidate, obtains independent reviews, arbitrates against the original request, and promotes only the approved candidate.

## Command behavior

| Command | Manual effect | Automatic equivalent | Side effect or approval |
| --- | --- | --- | --- |
| `/cycle setup` | Inspect providers, stable models and role assignments. | Startup capability negotiation. | Read-only. |
| `/cycle run auto` | Route the next request deterministically. | Sending a request to `Cycle`. | Session-scoped preference. |
| `/cycle run quick` | Request the lightweight route. | Low-risk routing. | Critical work still cannot be silently downgraded. |
| `/cycle run full` | Force full architecture and both reviews. | Critical-risk routing. | More model and verification work. |
| `/cycle status` | Return state, mode, candidate and repair budget. | Durable state transitions. | Read-only. |
| `/cycle tasks` | Return durable task identifiers and states. | Architecture and execution scheduling. | Read-only. |
| `/cycle evidence` | Return candidate gate records without raw command output. | Verification capture. | Read-only and redacted. |
| `/cycle models [role] [provider/model]` | Inspect or set a process-scoped assignment. | Active-model inheritance. | No credential access. |
| `/cycle permissions` | Inspect preset and immutable role boundaries. | `balanced` default. | Read-only. |
| `/cycle limits` | Inspect machine-wide admission policy. | Adaptive admission. | Read-only. |
| `/cycle pause` | Pause at the next safe boundary. | Resource or compatibility block. | Verification and delivery remain atomic. |
| `/cycle resume` | Resume the exact paused phase. | Recovery reconciliation. | Rejects workflows not paused. |
| `/cycle cancel --confirm` | Abort role sessions and cancel the workflow. | None. | Explicit confirmation required. |
| `/cycle retry` | Retry a classified infrastructure failure. | Bounded transient retry. | Does not add repair cycles. |
| `/cycle history` | Query redacted ledger events. | Continuous audit capture. | Read-only. |
| `/cycle history verify` | Verify the chain and signed checkpoints. | Daemon startup verification. | Read-only. |
| `/cycle memory search` | Search bounded project knowledge. | Progressive retrieval. | Read-only. |
| `/cycle memory explain` | Load one entry and its provenance. | Memory selection diagnostics. | Read-only. |
| `/cycle memory remove --confirm` | Revoke one entry. | Retention policy. | Explicit confirmation required. |
| `/cycle doctor` | Verify database, ledger, resources and protocol. | Startup health checks. | Read-only. |
| `/cycle export --confirm` | Export redacted ledger and public checkpoints. | Never automatic. | Explicit confirmation required. |
| `/cycle help` | Render the runtime-owned command reference. | First-use guidance. | Read-only. |

## Failure classes

| Symptom | Meaning | Recovery |
| --- | --- | --- |
| `safe mode` | A required host capability is missing, the Desktop version is below 1.18.16, or the major version is not 1. | Preserve data, restore a 1.x Desktop at or above 1.18.16, then run `doctor`. An uncertified but compatible 1.x update is not safe mode; `doctor` reports it and Cycle continues. On OpenCode 2.x and later, safe mode is expected: the plugin API changed with the major version and a Cycle build targeting it is required. |
| `cpu_pressure`, `memory_pressure`, or `disk_pressure` | Admission reserve would be violated. | Stop unrelated heavy work or free disk; admission retries without consuming a repair cycle. |
| `concurrency_limit` or `fair_queue` | Another governed workflow currently owns capacity. | Wait; the lease is renewed while active and expires after a crash. |
| `blocked` after rejection | The five-cycle repair budget is exhausted. | Inspect evidence and the original request, amend inputs if needed, then explicitly authorize recovery. |
| mandatory gate failed | Build, test, database, browser, security or packaging evidence did not pass. | Fix the reported failure; never mark the gate skipped merely to continue. |
| candidate changed | Files or candidate identity changed after freeze. | Discard the stale reviews and freeze a new candidate. |
| delivery conflict | Source HEAD changed or approved paths overlap newer edits. | Preserve both worktrees, reconcile deliberately, then run a new candidate cycle. |
| ledger verification failed | Local history or checkpoint integrity cannot be proven. | Stop the daemon, preserve the data directory, restore a trusted backup or report a security issue. |

## Crash and restart

Workflow state, task state, original request, candidates, evidence, history, memory and code graph are durable SQLite records. Managed implementation worktrees are outside the OpenCode installation. Expired resource leases are reclaimed after a crash, while idempotency receipts prevent a repeated native request from applying the same transition twice.

Do not delete the data directory to fix a startup error. Close OpenCode, copy the entire directory, and preserve the project Git repository. Run `/cycle doctor` after restoring the compatible plugin and control-plane generation.

## Delivery safety

Execution occurs in a managed Git worktree. Approval changes the workflow to `delivery`; it does not claim completion. Delivery rechecks the source revision, applies the exact stored approved diff without overwriting unrelated dirty changes, verifies every promoted file digest, and only then marks the workflow `completed`. Repeating a completed promotion is idempotent.
