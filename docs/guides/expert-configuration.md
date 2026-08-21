# Expert Configuration

Cycle for OpenCode uses OpenCode's native configuration. It does not maintain a second settings interface and never reads provider credentials.

## Plugin options

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-cycle",
      {
        "architectModel": "provider/model",
        "executorModel": "provider/model",
        "functionalReviewerModel": "provider/model",
        "securityReviewerModel": "provider/model",
        "arbiterModel": "provider/model",
        "permissionPreset": "balanced",
        "browserHeadless": true,
        "browserMaxSessions": 2,
        "browserAllowedOrigins": ["https://staging.example.com"]
      }
    ]
  ]
}
```

Every model value uses an OpenCode `provider/model` identifier. Omitting a role makes it inherit the model and named variant active when intake begins. `/cycle models <role> <provider/model>` changes an assignment for the current OpenCode process only; put the assignment in `opencode.json` to persist it. Native role-agent `variant`, `reasoningEffort` and `thinking` settings remain under OpenCode control; `/cycle models` reports only those reasoning fields and never returns credentials or unrelated provider options.

The supported role names are `architect`, `executor`, `functional_reviewer`, `security_reviewer`, and `arbiter`. Using different model families for both reviewers and the arbiter reduces correlated errors but is not required.

## Configuration precedence

OpenCode resolves user-global and project configuration. Within the effective configuration, explicit native agent settings take precedence over generated role defaults, plugin options take precedence over inheritance, and a `/cycle run` or `/cycle models` override applies only to the documented session scope. Configuration merging is idempotent and preserves unrelated agents, commands, providers, MCP servers, plugins, tools and permissions.

## Permission presets

`permissionPreset` accepts `safe`, `balanced`, or `autonomous`.

| Preset | Additional ceiling |
| --- | --- |
| `safe` | Tool use asks by default, external-directory access is denied, and loop-like behavior is denied. |
| `balanced` | OpenCode's effective policy is retained, external-directory access is denied, and loop-like behavior asks. |
| `autonomous` | OpenCode's effective policy is retained except for immutable role boundaries. |

The architect, functional reviewer, security reviewer and arbiter always deny edits and external-directory access. The executor always denies external-directory access. A preset can restrict an OpenCode permission but cannot elevate a permission that OpenCode denied or requires approval for.

Terminal, CLI, MCP, skill and plugin capabilities remain available through OpenCode when the executor's effective native policy permits them. Destructive actions, credentials, publishing, deployment and external data movement still follow native approvals and user intent.

The generated role agents are internal and hidden. Opening a role session directly does not bypass governance: direct role sessions are restricted to read-only inspection tools. Use Cycle's role consultation operations for advisory access, or start a governed workflow for execution.

## Managed browser

`browserHeadless` defaults to `true`. `browserMaxSessions` defaults to `2` and accepts values from `1` through `8`. The low default prevents browser processes from bypassing machine-wide workflow admission limits.

`browserAllowedOrigins` accepts an array of exact HTTP or HTTPS origins, or a comma-separated string. Loopback origins are always allowed. Every other origin requires a native OpenCode approval unless it appears in this list. Approval is origin-specific and does not authorize sibling subdomains. Redirects and subresources outside the allowed set are blocked.

`browserExecutable` may point to a stable Chrome, Edge or Chromium executable when automatic discovery is unsuitable. The default discovery checks standard stable-browser locations on Windows and Linux. Browser profiles are isolated and temporary; screenshots and hash-bound action receipts are retained under the normal Cycle for OpenCode data directory, never in the repository.

## Resource policy

One per-user control plane governs every project. The active-workflow ceiling is half the available logical CPUs, rounded up and clamped from one to eight. Admission pauses when CPU exceeds 85%, available memory would fall below a 1 GiB reserve, or available disk would fall below a 2 GiB reserve. One workflow per second is admitted after resource pressure to prevent a recovery stampede. Project queues use round-robin fairness, and indexing yields to verification.

`/cycle limits` reports these effective values. v1 does not allow a model to raise them at runtime. This prevents one project or prompt from weakening the machine-wide safety boundary.

## Development-only overrides

`binaryPath`, `dataDirectory`, and `hostVersion` exist for installed-package certification and controlled development tests. They are not normal user options. Pointing them at untrusted binaries or shared directories moves those components inside the local trust boundary and invalidates release certification.
