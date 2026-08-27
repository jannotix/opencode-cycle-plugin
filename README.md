# Cycle for OpenCode

<p align="center">
  <img src="assets/logo.svg" width="160" alt="Cycle logo">
</p>

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
- Version 1.0.0 certifies Windows x64 and Linux x64; macOS x64 and arm64 are compatible but untested.

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

## Platform support

| Platform | Status |
| --- | --- |
| Windows x64 | Certified on OpenCode Desktop 1.18.21 |
| Linux x64 | Certified on OpenCode Desktop 1.18.21 |
| macOS x64 | Compatible but untested |
| macOS arm64 | Compatible but untested |

Certified means a Desktop certification receipt exists for that platform on the released revision. Compatible but untested means the packages are built, published and resolvable, and no Desktop certification evidence covers them; `/cycle doctor` reports the distinction for the platform you are on.

## Supported OpenCode versions

Cycle for OpenCode 1.x targets the OpenCode 1.x plugin API.

| Host | Status |
| --- | --- |
| OpenCode Desktop 1.18.21 | Certified: Windows x64 and Linux x64 Desktop receipts exist for this release |
| OpenCode Desktop 1.18.16 to 1.18.20, and newer 1.x | Compatible: Cycle runs and reports that the host is outside the certified evidence set |
| OpenCode Desktop below 1.18.16 | Safe mode: Cycle loads but stays inert |
| OpenCode 2.x and later | Safe mode: the plugin API changed with the major version, so a separate Cycle build targeting it is required |

Certification follows evidence, not intent: a host appears as certified only
while a Desktop receipt exists for it on the released revision. On an
incompatible major version Cycle does not crash. It loads, stays inert, and
says that the plugin API differs and that a build targeting that host is
needed, so the refusal cannot be mistaken for a defect.

The product name is Cycle for OpenCode. Supported installations keep the existing data-directory folder name so current installs are not moved:

| Platform | Data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\OpenCode Cycle` |
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
