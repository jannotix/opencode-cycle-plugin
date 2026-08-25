# Release and Artifact Verification

Cycle for OpenCode is published only from a release candidate that passes all quality, security, packaging, Desktop, scale and repeatability jobs for one immutable Git revision.

## 1.0.0 platform coverage

Version 1.0.0 supports and certifies OpenCode Desktop on Windows x64 and Linux x64 only. It does not ship macOS packages.

## Published files

A release contains the JavaScript plugin and native `workflowd` packages for Windows x64 and Linux x64. It also publishes `SHA256SUMS`, a CycloneDX 1.6 SBOM, a release manifest, Windows and Linux Desktop certification records, scale evidence and build-provenance attestations.

Production archives are allowlisted. The plugin archive contains compiled ESM, one exact generated CommonJS browser-runtime companion, its manifest, `LICENSE` and `NOTICE`. A native archive contains one stripped executable, its manifest, `LICENSE` and `NOTICE`. Tests, fixtures, examples, benchmarks, source, source maps, documentation, logs, databases, caches, CI files and debug output are rejected.

The browser-runtime companion bundles only the pinned Puppeteer code used by the managed browser. Exact `@puppeteer/browsers` runtime subpaths remain external and that package is a direct pinned plugin dependency, so its optional-peer declarations remain authoritative. The unrelated `@puppeteer/browsers` CLI export and its Yargs loader graph never enter the candidate graph.

## Verify a downloaded candidate

1. Confirm the GitHub release tag and commit match the `version` and `revision` in `release-manifest.json`.
2. Verify every downloaded file against `SHA256SUMS` using the platform SHA-256 tool.
3. Verify the GitHub build-provenance attestation for each artifact.
4. Inspect the release manifest for certified Windows and Linux Desktop evidence and both `codebase-500k` and `critical-suite` quality records.
5. Inspect the SBOM and the release notes for security advisories or compatibility restrictions.
6. Install only the plugin name documented by the release; never download a standalone daemon from an unrelated location.

The manifest refuses missing or duplicate platform evidence. Desktop evidence must contain the native activation marker and compatible control-plane protocol/schema. Scale evidence must report more than 500,000 inventoried, parsed and physical files. Repeatability evidence must report twenty completed iterations out of twenty requested. Each evidence file is bound by SHA-256.

## Re-run a Desktop certification

Run the certification on the matching native operating system and architecture:

```text
bun scripts/ci/desktop-certification.ts --platform <platform> --plugin-archive <plugin.tgz> --native-archive <native.tgz> --revision <git-sha> --output <evidence.json>
```

Supported platform values are `windows-x64` and `linux-x64`. The command downloads the pinned official OpenCode Desktop asset, verifies its exact byte count and SHA-256, validates the platform signature where available, extracts it without invoking the installer, launches the unmodified application with its official isolated test profile, loads the plugin through native OpenCode configuration and verifies the control-plane protocol. Windows protocol registration is snapshotted before launch and restored after termination.

For an offline or repeated run, append `--desktop-asset <path>`. A supplied file is copied into the disposable certification workspace and must match the same pinned byte count and SHA-256; local input never bypasses authenticity or compatibility checks.

Before Desktop launch, certification materializes a private copyfile dependency tree inside the isolated plugin root and rejects ancestor resolution, links, hard links and path escapes. It opens and retains every full-tree file handle and verified byte buffer. From that held session it builds a hash-bound virtual module filesystem containing JavaScript/CommonJS/ESM source, resolution JSON, and metadata-only records for manifest-exported native or asset targets; source maps, documentation, licenses, unrelated data and binary bodies are not serialized into Electron. The receipt records the distinct full-tree file count, runtime-input file count, serialized byte count and runtime-input digest. Its held-content manifest uses an exact versioned JSON schema: device, inode, mode, link count, size, modification time and change time are canonical unsigned decimal strings, so Linux `bigint` stats and Windows identities cannot be truncated or serialized differently. One self-contained trusted linker under the exact pinned official Electron/Node runtime validates that input, bundles the exact pinned Acorn parser, parses ESM and CommonJS completely, follows only statically provable module edges, links every reachable ESM module with `vm.SourceTextModule`, and never evaluates candidate code. Nonliteral or aliased loaders, generated evaluation, forbidden builtins, missing required modules/manifests/assets and malformed optional-package paths fail closed. CommonJS, JSON and resolution-only asset counts are recorded separately from actually linked ESM modules. Pre-link and post-link handle metadata, path identity, root membership and the complete tree hash must remain identical.

On Windows, task verification is hosted by the packaged release `workflowd`. It creates the requested process suspended, assigns it to a private Job Object with kill-on-close before resume, preserves exact standard streams and closes the Job after natural exit or bounded terminate control. Assignment failure terminates and waits on the exact suspended process handle; a stalled control path terminates the exact live host handle and waits, causing Job close to remove the complete contained tree. Linux keeps the existing detached process-group boundary.

The packed-plugin gate never fabricates Electron or Node identity. Set `CYCLE_OFFICIAL_ELECTRON_RUNTIME` to the canonical absolute path of the retained official runtime when running `bun run test:package`; the gate fails closed when that runtime is absent.

A final authoritative package gate must also set `CYCLE_OFFICIAL_ELECTRON_EVIDENCE_DIR` to an absent direct child of the operating-system temporary directory whose basename starts with `opencode-cycle-official-evidence-`. The trusted outer gate creates and validates that directory without clobbering before native build, packaging or runtime work. It atomically records a start receipt and ordered stage heartbeats, including held-graph preparation and the runtime process PID, bounded duration, exit, timeout, output-limit state, byte counts and output digests. Success adds the exact linker result and runtime receipt, diagnostics, bundled linker, candidate entry and wrapper, full held-content tree manifest, bounded gate-output summary and a digest-bound final exit receipt. Failure adds a classified, digest-only final failure receipt even when the error occurs before or during packaging, linking or runtime execution. Internal scratch is cleaned only after final evidence publication; the external evidence directory is never removed by gate cleanup. Existing, nonempty, linked, nested or stale-schema evidence targets fail closed. Running the package gate without this evidence variable retains its existing non-authoritative behavior and does not publish durable proof.

## Publication order

Native packages are published before the plugin so its optional platform dependency is resolvable. The plugin is published last. GitHub release creation occurs only after package publication succeeds. npm and GitHub publication use a protected `release` environment; local developer machines are not an authorized publication path.

The first publication of a new npm package name requires a protected bootstrap publishing credential because package-level trusted publishing cannot be configured until the package exists. Immediately after v1 bootstrap, configure `publish.yml` as the trusted publisher for all three packages, allow `npm publish`, require two-factor authentication, disallow traditional publishing tokens, and revoke the bootstrap secret. Subsequent releases use GitHub OIDC and npm-generated provenance. When every package already exists, maintainers may switch the trusted relationship to stage-only publication for an additional human 2FA approval before public availability.

## License date

Every released version is available under FSL-1.1-MIT from its publication date and becomes additionally available under MIT on the second anniversary of that version's publication. Preserve `LICENSE`, `NOTICE`, release date and copyright information when redistributing.
