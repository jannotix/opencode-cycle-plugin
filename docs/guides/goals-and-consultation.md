# Goals and Role Consultation

Cycle for OpenCode separates discussion, long-term intent and implementation. This avoids running an expensive delivery cycle when the user only needs architecture advice, while preserving full governance when files must change.

## Choose the smallest mode

| Need | Use | Project mutation |
| --- | --- | --- |
| Discuss requirements or architecture | Architect consultation | No |
| Challenge functional completeness | Functional review | No |
| Challenge security or architecture | Security review | No |
| Check whether a plan is ready | Arbiter readiness | No |
| Estimate implementation feasibility | Executor feasibility | No |
| Deliver one bounded change | Quick or full workflow | Governed executor only |
| Deliver a product across milestones | Goal containing linked workflows | Governed executor only |

The full workflow remains the only path that can produce a candidate approval. A standalone arbiter cannot approve a release, and a standalone executor cannot run commands or edit files.

## Architect consultation

Select `Cycle` and ask for the architect explicitly. Cycle opens one isolated architect child session and reuses it for subsequent architect turns in the same parent session. The architect receives each exact current user message and the focused persisted goal and plan, if any.

The consultation can inspect the repository with read-only tools. It cannot edit files, start an executor or approve its own plan.

## Persistent goals

A goal is an outcome that may require several workflows. It stores:

- the exact objective and its digest;
- separately hashed user amendments;
- success criteria, constraints and non-goals;
- the latest versioned plan and its source session;
- the focused OpenCode session;
- linked workflow identifiers and milestone names;
- continuation count, with a default maximum of five;
- a durable lifecycle and project history events.

Goal states are `draft`, `planning`, `ready`, `active`, `paused`, `blocked`, `completing`, `completed` and `aborted`.

## Recommended goal flow

1. Tell Cycle the exact outcome and ask it to create a goal. Goal creation requires at least one explicit success criterion and a native approval.
2. Discuss the outcome with the architect until requirements, non-goals, risks and milestones are clear.
3. Ask Cycle to save the plan. Each save creates a new immutable revision.
4. Ask the functional reviewer and security reviewer to challenge the plan independently.
5. Ask the arbiter for readiness. This verdict is advisory and cannot approve a release candidate.
6. Mark the goal ready and activate it through the native approval.
7. Implement one bounded milestone at a time. Cycle links each run to the goal by goal identifier and milestone name.
8. Request completion only after every linked workflow has completed its own verification, review and arbitration gates.

The original goal objective is never replaced by an architect summary. Amendments are appended, not rewritten into the original record.

## Automatic behavior

Cycle calls the goal and role tools from natural-language requests. Users do not need to construct tool JSON. The complete internal operation names and required fields are listed in the [Automatic Operation Reference](../commands/automatic-operations.md) for auditability and expert troubleshooting.

## Failure behavior

- A goal cannot become ready without a saved plan.
- Plans can be saved only while the goal is in planning.
- A workflow cannot link to a goal in another project.
- Goal completion is rejected while any linked workflow is incomplete.
- Abort, block and completion rejection require a reason.
- The sixth continuation is rejected unless a new owner-authorized policy changes the governing limit.
- Repeated operation identifiers are idempotent and do not duplicate history.
