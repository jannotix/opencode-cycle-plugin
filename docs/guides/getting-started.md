# Getting Started

Cycle for OpenCode is a native OpenCode plugin. It has no separate window, dashboard, account or provider credentials. Select the `Cycle` primary agent in OpenCode Desktop and describe the outcome you need.

## Requirements

- OpenCode Desktop 1.18.16 or newer on the 1.x line. Release evidence covers `1.18.16` and `1.18.18`. A newer 1.x Desktop update keeps Cycle running when the required plugin capabilities are present; `/cycle doctor` and `/cycle help` report that the host is compatible but uncertified. Safe mode is only for hosts below 1.18.16, a different major version, or a missing plugin capability.
- Git available on PATH. Implementation, freeze and delivery require a Git repository; unversioned folders cannot complete a governed workflow.
- At least 2 GiB of free disk space and 1 GiB of available memory beyond the active project's own tools.
- The model providers you want to use already configured in OpenCode.
- A stable Chrome, Edge or Chromium installation when managed browser QA is required.

## Install

Public installation starts only after v1 certification. Once a release is available, add the package to a project `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cycle"]
}
```

OpenCode installs the JavaScript package and the matching native binary through its supported plugin mechanism. Do not copy files into the OpenCode application directory and do not start `workflowd` manually.

Restart OpenCode Desktop, open the project, select `Cycle`, and run:

```text
/cycle setup
/cycle doctor
```

`setup` shows only non-secret provider and model metadata. `doctor` verifies the local database, history chain, runtime resources and protocol compatibility. If either reports safe mode or a failed check, do not start a workflow; follow [Operations and Recovery](operations-and-recovery.md).

## Default Setup

With no plugin options, all five roles inherit the model active in the Cycle conversation and use the `Balanced` permission preset. The roles still run in separate OpenCode sessions with independent prompts and information boundaries.

`/cycle run auto` uses deterministic risk markers. Words such as `api`, `database`, `install` or `permission` typically select `full`. Use `/cycle run quick` when you want the reduced path for a bounded change. Independent ready tasks still run one at a time. Each role call waits up to 30 minutes.

Run `/cycle setup` to inspect the non-secret provider and model inventory exposed by OpenCode. The report lists provider identifiers, stable models, effective role assignments and a correlation warning when both reviewers and the arbiter use the same model. The warning does not block execution.

Cycle for OpenCode never reads, copies or stores provider API keys. Provider authentication remains owned by OpenCode.

## Assign Independent Models

Model assignment is optional and uses OpenCode's native `provider/model` identifiers:

```json
{
  "plugin": [
    [
      "opencode-cycle",
      {
        "architectModel": "provider-a/model-a",
        "executorModel": "provider-a/model-b",
        "functionalReviewerModel": "provider-b/model-c",
        "securityReviewerModel": "provider-c/model-d",
        "arbiterModel": "provider-d/model-e",
        "permissionPreset": "balanced"
      }
    ]
  ]
}
```

Omit any role option to inherit the active model. Explicit native OpenCode configuration for a generated role agent takes precedence over plugin defaults.

Supported permission presets are `safe`, `balanced` and `autonomous`. A preset can only restrict or preserve OpenCode's effective permissions; it cannot elevate them. Architect, reviewer and arbiter roles always deny file edits and external-directory access. The executor remains limited to the authorized project or isolated worktree.

## Discuss Before Implementing

An ordinary message does not automatically create an implementation workflow. Ask Cycle to discuss requirements, compare designs or plan with the architect. The consultation remains read-only and can continue across multiple turns.

Examples:

```text
Ask the architect to help me define the tenancy and billing boundaries for this SaaS.
Have the security reviewer challenge this plan.
Ask the arbiter whether this plan is ready for implementation.
```

The executor is available outside a workflow only for feasibility analysis. It cannot run commands or modify files in that mode. Standalone reviewer and arbiter results are advisory; final approval exists only inside a governed workflow.

## Start a Workflow

State implementation intent in the Cycle conversation, for example, `Implement this approved plan in full mode.` Cycle then calls the run operation with the exact captured user message, not a model-generated paraphrase.

For deterministic routing, arm the next request first:

```text
/cycle run auto
/cycle run quick
/cycle run full
```

`auto` is the default. It uses deterministic risk facts to avoid an expensive full workflow for a narrow low-risk change. Critical work cannot be downgraded without explicit user approval.

`/cycle run` does not implement the command text itself. It arms the next non-command user message in the same session, preserving that message and its attachments as the immutable request.

The original request is captured before architecture begins. Clarifications are appended separately. The final arbiter receives the original request, amendments, exact candidate, raw mandatory evidence and both finalized reviews; it never receives only the architect's summary.

Use `/cycle status`, `/cycle tasks` and `/cycle evidence` for native progress. Use `/cycle help` for the full command list.

For a multi-milestone product, create a persistent goal before implementation. See [Goals and Role Consultation](goals-and-consultation.md). For UI work, see [Managed Browser QA](managed-browser.md).

## Pause, resume and cancel

`/cycle pause` takes effect at the next safe boundary. Candidate verification and final delivery are atomic and finish before the paused state is entered. `/cycle resume` continues the exact saved phase. `/cycle cancel --confirm` stops admitted role sessions and marks the workflow terminal; it does not discard the isolated worktree, ledger or evidence.

## Updates and OpenCode application upgrades

Cycle for OpenCode stores its durable data outside the OpenCode installation, so an OpenCode application update cannot overwrite workflow state or project changes. On startup, the plugin checks the host contract: missing capabilities or an unsupported major/minimum version enter inert safe mode; a newer 1.x Desktop update keeps Cycle running and reports the uncertified host in doctor, help and `/cycle`. It never rewrites unrelated OpenCode configuration.

Before changing plugin versions, close OpenCode Desktop and back up the complete data directory. Version 1.0.0 supports Windows x64 and Linux x64 only; it does not ship macOS packages. Supported installations keep the existing data-directory folder name so current installs are not moved:

| Platform | Data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\OpenCode Cycle` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/opencode-cycle` |

Copy the entire directory while OpenCode is closed so the SQLite database, WAL state, signing key, IPC credential, checkpoints and managed worktrees remain consistent. The updater never stores durable state in a package cache or application bundle.

After an update, run `/cycle doctor` and `/cycle history verify` before resuming important work. An unsupported downgrade or newer database schema fails closed; restore the previous plugin version instead of altering the database.

## Remove the plugin

Remove `opencode-cycle` from the native `plugin` array and restart OpenCode. This disables the integration but intentionally preserves project changes and the data directory. Delete that directory only after closing OpenCode, making any required backup, and confirming that no history, memory, evidence or recoverable worktree is needed.

## Next references

- [Complete command reference](../commands/reference.md)
- [Expert configuration](expert-configuration.md)
- [Goals and role consultation](goals-and-consultation.md)
- [Managed browser QA](managed-browser.md)
- [Automatic operation reference](../commands/automatic-operations.md)
- [Operations and recovery](operations-and-recovery.md)
- [Project history](../commands/history.md)
- [Project memory](../commands/memory.md)
- [Release artifact verification](../releases/verification.md)
