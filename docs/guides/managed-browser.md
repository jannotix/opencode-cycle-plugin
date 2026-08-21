# Managed Browser QA

Cycle for OpenCode provides browser automation as a native OpenCode tool. It has no separate browser dashboard or plugin interface.

## When it runs

The architect includes browser verification when a request affects visible web behavior. An authorized executor can then open the local application, inspect its accessibility tree, interact with the affected flow, run deterministic checks, capture screenshots and inspect console or failed-request logs. The session closes automatically when the workflow ends, and the executor is also instructed to close it explicitly after use.

Read-only roles may open pages, inspect snapshots, run checks, capture screenshots and inspect logs. Click, fill, key press and upload operations require an orchestrator-authorized executor session. Directly opening a hidden role cannot bypass this boundary.

## Browser and profile isolation

The plugin discovers a stable Chrome, Edge or Chromium installation in standard operating-system locations. It launches a headless isolated profile by default. The profile is deleted after the session closes.

The plugin never connects to the user's normal browser profile and never imports its cookies, passwords, history or extensions. Use disposable test accounts and test data. Do not automate a production mutation unless the original request and native approvals explicitly authorize it.

## Network policy

HTTP and HTTPS loopback origins are allowed by default. URLs containing credentials and non-web schemes are rejected.

Opening any external origin requires a native OpenCode approval unless the exact origin is listed in `browserAllowedOrigins`. The approval covers only that origin for the current managed session. Cross-origin redirects and subresources remain blocked unless separately configured or approved.

## Selectors and deterministic checks

Prefer `role` with an accessible `name`, then `label` or `testId`. CSS selectors are available as a fallback. Deterministic checks can assert:

- a target is visible;
- expected text is present or exactly matches;
- the current URL contains or exactly matches a value.

A failed check throws and cannot be recorded as passed evidence. Accessibility snapshots are bounded before entering model context.

## Credentials and files

`fill` accepts either a literal test value or the name of an environment variable, never both. Environment-backed values are redacted from subsequent text snapshots and browser logs. Tool results never echo filled values.

Uploads must resolve inside the current project directory. Paths that escape the project are rejected. External downloads remain inside the isolated browser profile and are not promoted into the project automatically.

## Evidence and retention

Screenshots and the final session receipt are written outside the repository under the platform data directory:

| Platform | Browser evidence root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\OpenCode Cycle\browser` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/opencode-cycle/browser` |

The receipt records bounded logs and operation result digests without filled values or URL query strings. Screenshot and receipt paths are never included in production package archives.

## Resource limits

At most two managed browser sessions are active by default, with a configurable hard range of one through eight. When the limit is reached, new sessions fail closed until an idle session closes. This cap works with workflow admission and prevents browser processes from scaling with the number of persisted workflows.
