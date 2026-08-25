# Release and Artifact Verification

Cycle for OpenCode is published only from a release candidate that passes all quality, security, packaging, Desktop, scale and repeatability jobs for one immutable Git revision.

## 1.0.0 platform coverage

Version 1.0.0 supports and certifies OpenCode Desktop on Windows x64 and Linux x64 only. It does not ship macOS packages.

## Published files

A release contains the JavaScript plugin and native `workflowd` packages for Windows x64 and Linux x64. It also publishes `SHA256SUMS`, a CycloneDX 1.6 SBOM, a release manifest, Windows and Linux Desktop certification records, scale evidence and build-provenance attestations.

Production archives are allowlisted. The plugin archive contains compiled ESM, its manifest, `LICENSE` and `NOTICE`. A native archive contains one stripped executable, its manifest, `LICENSE` and `NOTICE`. Tests, fixtures, examples, benchmarks, source, source maps, documentation, logs, databases, caches, CI files and debug output are rejected.

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

Before Desktop launch, certification materializes a private copyfile dependency tree inside the isolated plugin root and rejects ancestor resolution, links, hard links and path escapes. The official Electron/Node process runs a trusted supervisor, which imports the candidate only in a separate same-runtime child and accepts one challenge-bound acknowledgement after import. Desktop evidence retains the supervisor, child wrapper, runtime executable, generated loader, candidate entry and dependency-tree digests.

The packed-plugin gate never fabricates Electron or Node identity. Set `CYCLE_OFFICIAL_ELECTRON_RUNTIME` to the canonical absolute path of the retained official runtime when running `bun run test:package`; the gate fails closed when that runtime is absent.

## Publication order

Native packages are published before the plugin so its optional platform dependency is resolvable. The plugin is published last. GitHub release creation occurs only after package publication succeeds. npm and GitHub publication use a protected `release` environment; local developer machines are not an authorized publication path.

The first publication of a new npm package name requires a protected bootstrap publishing credential because package-level trusted publishing cannot be configured until the package exists. Immediately after v1 bootstrap, configure `publish.yml` as the trusted publisher for all three packages, allow `npm publish`, require two-factor authentication, disallow traditional publishing tokens, and revoke the bootstrap secret. Subsequent releases use GitHub OIDC and npm-generated provenance. When every package already exists, maintainers may switch the trusted relationship to stage-only publication for an additional human 2FA approval before public availability.

## License date

Every released version is available under FSL-1.1-MIT from its publication date and becomes additionally available under MIT on the second anniversary of that version's publication. Preserve `LICENSE`, `NOTICE`, release date and copyright information when redistributing.
