# Command Reference

Select the native `Cycle` agent. Discussion and planning remain read-only; explicit implementation intent starts the governed workflow.
These commands provide deterministic routing, inspection, control, recovery, and expert configuration.

| Command | Purpose | Automatic equivalent |
| --- | --- | --- |
| `/cycle setup` | Guided configuration and compatibility checks | First-run initialization |
| `/cycle run [auto|quick|full]` | Arm the next exact request with a routing preference | Explicit implementation intent in Cycle |
| `/cycle status` | Show the latest workflow state, mode, candidate and repair budget | Native status updates |
| `/cycle tasks` | Show durable task identifiers and states | Scheduler operations |
| `/cycle evidence` | Show recorded candidate gates without raw command output | Verification pipeline |
| `/cycle models [role] [provider/model]` | Inspect assignments or assign a model until restart | Active-model inheritance |
| `/cycle permissions` | Inspect the immutable role boundaries and active preset | Balanced defaults |
| `/cycle limits` | Inspect adaptive admission and repair limits | Adaptive defaults |
| `/cycle pause` | Pause the latest workflow at its next safe boundary | Resource or compatibility pause |
| `/cycle resume` | Reconcile state and continue paused work | Resource recovery |
| `/cycle cancel` | Cancel authorized work safely | User interruption |
| `/cycle retry` | Retry a classified failure or blocked cycle | Transient retry policy |
| `/cycle history` | Query project audit events | Continuous ledger capture |
| `/cycle history verify` | Verify the hash chain and signed checkpoints | Checkpoint validation |
| `/cycle memory search` | Search reusable project knowledge | Progressive retrieval |
| `/cycle memory explain` | Explain memory source and confidence | Selection diagnostics |
| `/cycle memory remove` | Remove eligible memory | Retention policy |
| `/cycle doctor` | Run read-only installation and project diagnostics | Startup health checks |
| `/cycle export` | Export workflow state, ledger, or evidence | Never automatic |
| `/cycle help` | Show the complete command reference | First-use guidance |

Cancellation, memory removal and export require `--confirm` after explicit user approval.
