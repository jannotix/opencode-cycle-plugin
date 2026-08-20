# Cycle for OpenCode

Cycle for OpenCode is a native OpenCode plugin for evidence-gated software delivery. It adds one primary `Cycle` agent without replacing OpenCode `Plan` or `Build`.

## What it is

A local OpenCode integration that coordinates five isolated roles:

1. **Architect** — turns the original request into a bounded task plan.
2. **Executor** — implements one authorized scope at a time.
3. **Functional reviewer** — checks completeness and user-visible behavior.
4. **Security and architecture reviewer** — independently checks trust boundaries and architecture.
5. **Arbiter** — approves or rejects from the original request, the exact candidate, raw evidence and both reviews. The executor cannot approve its own work.

There is no separate dashboard, cloud account or extra UI. Everything runs inside OpenCode Desktop.

## What it solves

A single coding session can interpret a request, write the code, review its own assumptions and declare the job done. That hides unfinished layers: a backend without the UI flow, a migration never applied, tests that pass against mocks, or a security control that exists on one path only.

Cycle for OpenCode keeps the original request immutable, separates implementation from approval, and records inspectable evidence before delivery.

## Why use it

- Small work stays cheap (`auto` / `quick`). Risky work takes the full independent cycle.
- Real project tools and Git freeze/delivery, not a summary of what an agent claims it did.
- Durable state lives outside the OpenCode install, so OpenCode updates do not wipe workflows.
- Windows x64 and Linux x64 Desktop are the certified v1 platforms. macOS Desktop is untested.

## Install

After a certified release is published, add the package to `opencode.json` and restart OpenCode Desktop:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cycle"]
}
```

Select the `Cycle` agent, then run:

```text
/cycle setup
/cycle doctor
```

No separate application, Rust toolchain, service account or API key is required. Cycle never reads OpenCode provider keys.

## Uninstall

1. Remove `opencode-cycle` from the `plugin` array.
2. Restart OpenCode Desktop.

This disables the plugin and keeps your project files. Local Cycle state is preserved on purpose. Delete it only after OpenCode is closed and you no longer need history, memory or recoverable worktrees.

The product name is Cycle for OpenCode. Windows and macOS keep the existing data-directory folder name so current installs are not moved:

| Platform | Data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\OpenCode Cycle` |
| macOS | `~/Library/Application Support/OpenCode Cycle` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/opencode-cycle` |

## Usage

```text
/cycle run auto
/cycle status
/cycle help
```

The [user manual](docs/USER_MANUAL.md) and [getting started](docs/guides/getting-started.md) guides cover commands, Goal Mode, recovery and removal.

## License

FSL-1.1-MIT. See `LICENSE` and `NOTICE`. Cycle for OpenCode is an independent integration. It is not affiliated with, sponsored by or endorsed by the OpenCode project.

Repository: https://github.com/jannotix/opencode-cycle-plugin
