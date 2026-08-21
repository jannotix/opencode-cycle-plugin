# Automatic Operation Reference

These operations are native tools used by the `Cycle` agent and its governed child sessions. Users normally request them in plain English. Their names and arguments are documented so experts can audit transcripts, permissions and project history.

## Role consultation operations

| Operation | Role | Result |
| --- | --- | --- |
| `architect_consult` | Architect | Multi-turn requirements, tradeoffs or plan advice |
| `executor_feasibility` | Executor | Read-only feasibility, scope and verification analysis |
| `functional_review` | Functional reviewer | Advisory completeness and end-to-end plan findings |
| `security_review` | Security and architecture reviewer | Advisory trust, architecture and resource findings |
| `arbiter_readiness` | Arbiter | Advisory comparison of the exact request, goal and plan |

Every operation uses the exact current user request captured by the plugin. Standalone operations cannot modify files or issue final candidate approval.

## Goal operations

| Operation | Required fields | Effect |
| --- | --- | --- |
| `goal_create` | `successCriteria` | Creates and focuses a goal from the exact current request; native approval required |
| `goal_amend` | `goalId` | Appends the exact current user request as an immutable amendment |
| `goal_status` | Optional `goalId` | Returns the named or focused goal, latest plan and linked workflows |
| `goal_list` | None | Lists project goals |
| `goal_focus` | `goalId` | Focuses a project-owned goal in the current session |
| `goal_save_plan` | `goalId`, `document` | Saves a new plan revision and enters planning when the goal is draft |
| `goal_link_workflow` | `goalId`, `workflowId`, `milestone` | Links a same-project workflow to a milestone |
| `goal_transition` | `goalId`, `transition` | Applies one idempotent lifecycle transition |

Supported transitions are `start_planning`, `mark_ready`, `activate`, `pause`, `resume`, `block`, `resume_blocked`, `continue`, `request_completion`, `approve_completion`, `reject_completion` and `abort`.

`mark_ready`, `activate`, `request_completion`, `approve_completion` and `abort` require native approval. `block`, `reject_completion` and `abort` require a reason. `approve_completion` also requires completion evidence and every linked workflow must already be complete.

The `run` operation accepts optional `goalId` and `milestone` together. When supplied, the new workflow is linked immediately after immutable intake.

## Browser operations

| Operation | Main fields | Effect |
| --- | --- | --- |
| `open` | `url` | Opens HTTP or HTTPS in the isolated profile |
| `snapshot` | None | Returns a bounded accessibility snapshot, title and safe URL |
| `click` | Target | Clicks a target; executor only |
| `fill` | Target and one of `value` or `environmentVariable` | Fills an editable target without echoing the value; executor only |
| `press` | `key`, optional target | Sends a key; executor only |
| `upload` | Target and project-relative `path` | Uploads a contained project file; executor only |
| `check` | Target, `expectedText` or `expectedUrl` | Runs deterministic visibility, text or URL assertions |
| `screenshot` | Optional `fullPage` | Stores a PNG outside the repository and returns its SHA-256 digest |
| `logs` | None | Returns up to 200 bounded console, page-error and failed-request records |
| `close` | None | Closes the browser, writes the action receipt and removes the profile |

A target is one of `role` with optional `name`, `label`, `testId`, `text` or `selector`. Semantic targets are preferred over CSS.

## Native approvals

Goal approvals and external browser-origin approvals use OpenCode's native permission prompt. A model-provided boolean is not accepted as user approval. Tool attempts, decisions and results are recorded in project history by digest without storing credential values.
