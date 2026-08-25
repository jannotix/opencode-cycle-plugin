# Production and Distribution Plan

## Purpose

This document is the execution ledger for bringing Cycle for OpenCode 1.0.0 to
a verified production release and public distribution. It defines the required
source, package, runtime, security, certification, evidence, and publication
gates. A completed task must record its exact commit, commands, receipts, and
verdict in the receipt table.

This document does not authorize a push, CI dispatch, tag, package publication,
GitHub Release, credential change, or modification of private OpenCode
configuration.

## Operating rules

- One implementation task equals one atomic commit.
- Work on one task at a time and stop for independent review after its gate.
- Do not push, tag, dispatch CI, change private configuration, or publish
  packages without explicit owner approval for that action.
- Never edit source after the final revision is frozen. Any source change creates
  a new candidate and invalidates every earlier release receipt.
- Every receipt must name the exact full Git revision and prove a clean source
  state. Narrative, an LLM completion claim, or a green test count is not a
  substitute for the required evidence.
- Run release gates from clean clones with locked dependencies and pinned
  toolchains. Do not certify a developer worktree containing uncommitted files.
- A failed, incomplete, stale, malformed, or unsanitized receipt blocks the next
  task. Do not waive a gate by documentation or owner narrative.
- Do not stop unrelated processes or weaken a resource, security, or timeout
  limit to obtain a passing result.
- Keep provider credentials, model selections, private OpenCode configuration,
  absolute owner paths, nonces, IPC secrets, raw prompts, and raw process output
  out of source, archives, public evidence, logs, and screenshots.

## Approved v1 release contract

### Platform matrix

| Platform | Native archive | Desktop certification | Public status |
| --- | --- | --- | --- |
| Windows x64 | Required | Required | Certified only after the final exact-SHA lane passes |
| Linux x64 | Required | Required | Certified only after the final exact-SHA lane passes |
| macOS x64 | Required | Excluded | Compatible but untested |
| macOS arm64 | Required | Excluded | Compatible but untested |

The macOS native archives must be built and package-verified on matching macOS
CI runners during the Release Candidate workflow. No macOS Desktop activation,
workflow, or end-to-end certification is claimed. The manifest, README, user
manual, package metadata, capability output, and release notes must use the
exact phrase `compatible but untested` and must not contain a macOS
certification receipt or substitute another platform's evidence.

### OpenCode host policy

- OpenCode Desktop 1.18.21 is the sole v1.0.0 certification target.
- It becomes certified only after Windows x64 and Linux x64 pass on the final
  exact source revision with the same canonical plugin archive bytes.
- Earlier 1.18.16 and 1.18.18 evidence must not be carried forward as current
  release certification. They may be described as compatible historical hosts,
  or certified again only after fresh final-SHA Windows and Linux receipts.
- Newer compatible OpenCode 1.x versions may report compatible but uncertified;
  they must not silently enter the certified set.

### Exact distributable package set

For version `<version>`, the release package allowlist is exactly:

1. `opencode-cycle-<version>.tgz`
2. `opencode-cycle-native-win32-x64-<version>.tgz`
3. `opencode-cycle-native-linux-x64-<version>.tgz`
4. `opencode-cycle-native-darwin-x64-<version>.tgz`
5. `opencode-cycle-native-darwin-arm64-<version>.tgz`

Windows and Linux Desktop certification must consume one canonical plugin TGZ
built once on the Linux release lane. Both Desktop receipts must record the same
plugin name, size, and SHA-256. Native archives are built on their matching
operating-system lanes.

### Public source and production archive policy

The public Git repository must retain source, tests, fixtures, examples,
benchmarks, required CI and release scripts, schemas, security documentation,
installation and removal instructions, licenses, and user documentation.

Production npm archives use explicit allowlists. They must exclude tests,
fixtures, examples, benchmarks, source maps, development documentation, CI
files, local plans, logs, databases, caches, debug output, temporary files,
private configuration, and secrets. They must retain only runtime files,
package metadata, `LICENSE`, `NOTICE`, and generated production notices required
for lawful distribution.

### Task completion invariant

No LLM or role may persist a task as completed. A task may close only when:

1. every required deterministic verifier has passed against the exact candidate;
2. an independent reviewer has approved the same candidate and verifier evidence;
3. the durable transition validates both conditions atomically.

The architect, executor, reviewers, and arbiter may propose or report a result,
but none may bypass this invariant. The executor must stop and return the task
to the architect when the architecture is unsafe, contradictory, incomplete, or
not implementable within the authorized scope.

### Rollback policy

- Before publication, discard the candidate and create a new revision; never
  mutate a sealed candidate.
- If a native package publishes but the main plugin does not, stop publication,
  deprecate the partial native version with an installation warning, and do not
  create a GitHub Release.
- If public smoke verification fails after the plugin is published, deprecate
  all affected npm packages, mark the GitHub Release as withdrawn, preserve the
  evidence for incident review, and prepare a fixed patch release. Do not erase
  evidence or rewrite the tag.
- Do not rely on npm unpublish as the primary rollback mechanism. Use it only
  when npm policy permits it and the owner explicitly approves it.
- User project files and durable Cycle state must not be deleted by rollback or
  uninstall. Document recovery and explicit state removal separately.

## Current baseline

Recorded on 2026-08-25:

- The active hardening work is in `release/v1-readiness` at committed revision
  `39bc7d8dbafc51625f07d7cbeb994240966da0b0`, followed by an interrupted,
  uncommitted R5 package and Desktop-proof change set. It is not a releasable or
  certifiable revision.
- This planning copy is currently outside that active worktree and must enter the
  execution branch through an explicitly reviewed documentation commit.
- The current source and release workflow ship Windows x64 and Linux x64 only.
  macOS packages and compatible-but-untested manifest semantics remain work to
  implement and verify.
- OpenCode 1.18.21 dependencies and official asset metadata are pinned, but the
  host is not certified on the current revision.
- Existing Desktop, 500k, repeatability, and live-workflow evidence predates the
  future final revision and cannot certify it.
- No immutable final SHA, complete public artifact set, accepted Release
  Candidate workflow, npm package publication, or GitHub Release exists.
- Earlier identity-test counts are historical and must not be used as the
  current baseline. Fresh commands on the reviewed execution branch determine
  the next verdict.

## Release evidence contract

Every retained release receipt must be machine-readable, schema-validated,
sanitized, and bound to the exact full source revision. The final evidence must
prove:

- clean source identity and locked toolchain/dependency versions;
- exact package filename, byte size, SHA-256, package name, and version;
- the same canonical plugin TGZ in Windows and Linux Desktop receipts;
- official OpenCode 1.18.21 asset filename, byte size, SHA-256, product version,
  and platform authenticity result;
- isolated OpenCode config and data roots, plugin-owned activation, expected
  control-plane protocol/schema, daemon identity, authenticated shutdown, and
  final process absence;
- successful 20-of-20 critical-suite iterations;
- a passing code-intelligence corpus with more than 500,000 physical,
  inventoried, and parsed files, zero parse failures, graph/query/incremental
  checks, peak memory at or below 80 percent, and index plus total duration at
  or below 1,800,000 milliseconds;
- exact manifest evidence hashes and artifact bindings;
- a schema-valid CycloneDX 1.6 SBOM generated from the packed production
  dependency graph and exact archive bytes;
- `SHA256SUMS` covering every distributable archive and published metadata file;
- build provenance whose subjects are the exact archive bytes;
- successful checksum verification from a second fresh directory.

Public evidence must use allowlisted fields and digest-only diagnostics. It must
not publish raw wrapper/linker sources, temporary or owner paths, activation
nonces, credentials, raw subprocess output, private model/provider choices, or
unredacted user requests.

## Receipt ledger

Add a row only after the task and independent review have passed. Never copy
credentials, access tokens, sensitive logs, or private configuration here.

| Task | Commit | Verification command or workflow | Receipt path or URL | Verdict | Date | Notes |
| --- | --- | --- | --- | --- | --- | --- |

## Milestone M0 — Adopt the release contract

### T00 — Move the approved plan to the execution branch

**Goal:** Make this plan, the product documentation, and the active release
branch describe the same approved scope.

**Acceptance criteria:**

- The plan is tracked in `release/v1-readiness` through one documentation-only
  commit after the interrupted R5 work is either completed or safely separated.
- Windows and Linux are the only certified platforms.
- macOS x64 and arm64 are compatible but untested and excluded from Desktop
  certification.
- OpenCode 1.18.21 is the sole v1.0.0 certification target.
- The approved rollback policy, five-package inventory, certification states,
  and implementation order are internally consistent in this plan and product
  documentation. T02 and T02a own the corresponding source, test, workflow,
  and manifest changes.

**Verification:**

```text
git status --short --branch
git diff --check HEAD^
```

**Status:** Completed; the exact commit is the documentation-only commit that
contains this status update.

---

## Milestone M1 — Complete and review the source candidate

### T01 — Complete the interrupted R5 package and Desktop-proof hardening

**Goal:** Resolve the known package-runtime boundary, durable evidence privacy,
and canonical-plugin provenance findings without weakening the official runtime
proof.

**Acceptance criteria:**

- Runtime module loading fails closed for aliases, generated evaluation,
  forbidden built-ins, missing modules, and path escapes.
- Browser and tool runtime boundaries include only the required pinned code.
- Durable evidence contains no raw paths, nonces, private configuration, raw
  wrapper/linker sources, secrets, or raw subprocess output.
- One canonical plugin TGZ and provenance record can be reused byte-for-byte by
  both certified Desktop lanes.
- This task creates the focused runtime-linker, official-runtime-evidence, and
  release-workflow tests invoked below; each must fail before its corresponding
  production behavior is implemented.
- All focused tests, complete Bun tests, type checks, formatting, Clippy, and
  Rust tests pass before the atomic commit.

**Verification:**

```text
bun test scripts/ci/desktop-runtime-linker.test.ts scripts/ci/official-runtime-evidence.test.ts scripts/packaging/plugin-package.test.ts scripts/release/release-workflow.test.ts
bun run check
bun test
cargo test --workspace --all-features
git status --short
```

**Status:** In progress, uncommitted

### T02 — Implement macOS compatible-but-untested packaging

**Goal:** Add macOS x64 and arm64 production archives without creating a false
Desktop certification claim.

**Acceptance criteria:**

- Darwin x64 and arm64 native packages are platform-bound and allowlisted. The
  Release Candidate workflow builds them on matching macOS CI runners and
  includes them in publication order.
- The main plugin declares both macOS packages as exact-version optional
  dependencies and resolves the correct native package on each target.
- Manifest and publication schemas distinguish `certified` Windows/Linux from
  `compatible-but-untested` macOS.
- No macOS Desktop receipt is required, accepted, generated, or substituted.
- README, manual, verification guide, capability output, and release notes use
  the approved compatibility wording.

**Verification:**

```text
bun test packages/opencode-cycle/test/client.test.ts scripts/packaging/plugin-package.test.ts scripts/release/release-manifest.test.ts scripts/release/publication-plan.test.ts scripts/release/release-workflow.test.ts
```

**Status:** Not started

### T02a — Migrate the publish workflow to npm trusted publishing

**Goal:** Remove long-lived publish-token authentication from the release
workflow before the final source revision is frozen.

**Acceptance criteria:**

- `.github/workflows/publish.yml` publishes through GitHub Actions OIDC with
  `id-token: write`; it has no `NODE_AUTH_TOKEN` or `secrets.NPM_TOKEN` publish
  path.
- The pinned npm CLI and the publish commands support first-publication public
  access and trusted-publishing provenance for every archive in the publication
  order.
- The release-workflow test created in T01 rejects a static publish token,
  missing OIDC permission, or a missing `release` environment declaration.
- This task changes no package version and creates no package, tag, or GitHub
  Release.

**Verification:**

```text
bun test scripts/release/release-workflow.test.ts
if (rg -n 'NODE_AUTH_TOKEN|secrets\.NPM_TOKEN' .github/workflows/publish.yml) { throw 'Static npm publish token found' }
```

The second command must complete without throwing.

**Status:** Not started

### T03 — Restore a complete public-source and quality baseline

**Goal:** Produce the first clean source revision eligible for provisional host
testing.

**Acceptance criteria:**

- The public source tree retains tests, fixtures, examples, schemas, required
  CI/release scripts, license files, install/uninstall documentation, user
  manual, and security documentation.
- Generated contracts and command references are current and documentation links
  resolve.
- Product identity, licenses, type checks, formatting, Clippy, Bun tests, and
  Rust tests pass.
- No test expectation is changed merely to conceal a production defect.
- The worktree is clean after the atomic commit.

**Verification:**

```text
bun install --frozen-lockfile
bun run check
bun test
cargo test --workspace --all-features
git status --short
```

**Status:** Not started

---

## Milestone M2 — Prove product and host invariants

### T04 — Verify deterministic task closure and independent review

**Goal:** Prove that no agent or LLM can close a task without deterministic
verification and an independent reviewer.

**Acceptance criteria:**

- Positive tests close a task only when both required conditions are present for
  the exact candidate.
- Negative tests reject executor, architect, reviewer, arbiter, stale candidate,
  mismatched evidence, missing verifier, failed verifier, and self-review bypass
  attempts.
- Persistence and recovery preserve the invariant atomically across restart and
  concurrent requests.
- The executor stops and escalates invalid architecture before implementation.
- This task creates `task-verification.test.ts` and `task-review.test.ts`; the
  files cover the positive and negative conditions listed above rather than
  merely asserting implementation details.

**Verification:**

```text
bun test packages/opencode-cycle/test/task-verification.test.ts packages/opencode-cycle/test/task-review.test.ts packages/opencode-cycle/test/executor.test.ts packages/opencode-cycle/test/full-workflow.test.ts
cargo test -p workflow-store verification
cargo test -p workflowd verification
```

**Status:** Implemented previously; final-revision verification pending

### T05 — Run provisional OpenCode 1.18.21 Desktop proof

**Goal:** Establish that the current candidate can activate and shut down on the
target host before changing the certified-host policy.

**Acceptance criteria:**

- Packaged Windows x64 and Linux x64 candidates pass the official isolated
  OpenCode Desktop 1.18.21 proof on their matching native operating systems.
- Both lanes use the same canonical plugin TGZ bytes and bind their matching
  native archives.
- Receipts remain provisional and do not certify the source after a subsequent
  host-policy commit.
- macOS is excluded from this task.

**Verification:**

```text
bun scripts/ci/desktop-certification.ts --platform <windows-x64|linux-x64> --plugin-archive <canonical-plugin.tgz> --plugin-provenance <canonical-plugin.provenance.json> --native-archive <native.tgz> --revision <provisional-sha> --output <provisional-receipt.json>
```

**Status:** Not started

### T06 — Promote OpenCode 1.18.21 and remove stale certification claims

**Goal:** Change the certified-host policy only after both provisional native
proofs pass.

**Acceptance criteria:**

- OpenCode 1.18.21 is the only v1.0.0 certified-host target in production code
  and current user documentation.
- 1.18.16 and 1.18.18 are not presented as current release certifications
  without fresh final-SHA evidence.
- The promotion is one atomic commit and explicitly invalidates provisional
  receipts for final release purposes.

**Verification:**

```text
bun test packages/opencode-cycle/test/capabilities.test.ts packages/opencode-cycle/test/host-version.test.ts scripts/release/release-manifest.test.ts
bun run check
git status --short
```

**Status:** Not started

---

## Milestone M3 — Certify one immutable final revision

### T07 — Freeze the revision and run clean-clone product gates

**Goal:** Establish one immutable source revision for every final receipt and
artifact.

**Precondition:** M0 through M2 are complete, independently reviewed, committed,
and clean.

**Acceptance criteria:**

- Record one full final Git revision and create fresh Windows and Linux clean
  clones at exactly that revision.
- Install locked dependencies with Bun 1.3.14 and use pinned Rust 1.97.1.
- Run complete source, dependency, security, build, integration, native package,
  and packed plugin gates.
- Build the canonical plugin archive once on Linux and retain its provenance for
  both Desktop lanes.
- Build and package Windows and Linux native archives on their matching local
  certification systems. Validate the macOS build, package, and allowlist lanes
  statically; their native execution occurs after the approved push in T11.
- Any vulnerability exception is documented, time-bounded, independently
  reviewed, and owner-approved.

**Verification:**

```text
bun install --frozen-lockfile
bun run check
bun test
cargo test --workspace --all-features
bun run audit
bun run build
bun run test:control-plane
bun run test:native-package
bun run test:package
git status --short
git rev-parse HEAD
```

The authoritative packed-plugin command must use the retained official Electron
runtime and a fresh external evidence directory as required by the verification
guide.

**Status:** Not started

### T08 — Produce final scale and repeatability receipts

**Goal:** Prove the frozen revision meets non-functional release gates.

**Acceptance criteria:**

- The 500,000-file benchmark satisfies every bound in the release evidence
  contract and reports `passed: true`.
- The critical suite passes 20 consecutive iterations out of 20 requested.
- Both sanitized JSON receipts name the final full revision and are retained
  with the candidate evidence.
- The source tree remains clean and unchanged.

**Verification:**

```text
bun run test:scale:500k
bun run test:repeat-critical
git status --short
```

**Status:** Not started

### T09 — Certify Desktop and the complete live product matrix

**Goal:** Prove packaged production artifacts in isolated real OpenCode Desktop
1.18.21 profiles on Windows x64 and Linux x64.

**Acceptance criteria:**

- Both native lanes activate the same canonical plugin TGZ and their matching
  native archive from fresh isolated config and data roots.
- Both receipts prove the official Desktop asset identity and authenticity,
  plugin-owned activation, expected protocol/schema, daemon identity,
  authenticated shutdown, and final process absence.
- Every role is invoked separately: architect, executor, functional reviewer,
  security and architecture reviewer, and arbiter.
- Every generated command-reference entry is exercised or explicitly mapped to
  deterministic automated evidence. At minimum this includes `/cycle setup`,
  `doctor`, `run`, `status`, `tasks`, `evidence`, `history`, `memory`, `help`, and
  documented recovery operations.
- Auto, Quick, and Full modes complete their intended live paths.
- Goal Mode completes goal creation, milestone activation, workflow delivery,
  evidence linkage, completion request, and final approval.
- Negative live paths prove failed verification, reviewer rejection, repair,
  cancellation, recovery, and the deterministic task-closure invariant.
- Project history records who performed each action and when it occurred.
- An English request and a non-English request both preserve the original user
  intent through the architect and arbiter without changing the English-only
  product documentation or messages.
- Private model/provider selections are used only from private OpenCode
  configuration and never enter source or evidence.
- macOS remains excluded from Desktop and live certification.

**Verification:**

```text
bun scripts/ci/desktop-certification.ts --platform <windows-x64|linux-x64> --plugin-archive <canonical-plugin.tgz> --plugin-provenance <canonical-plugin.provenance.json> --native-archive <native.tgz> --revision <final-sha> --output <receipt.json>
```

Attach the sanitized live acceptance matrix and transcripts to the private
candidate evidence bundle. Publish only the allowlisted receipt fields.

**Status:** Not started

---

## Milestone M4 — Seal and verify the Release Candidate

### T10 — Obtain push and Release Candidate dispatch approval

**Goal:** Put the exact frozen revision on GitHub without expanding the approved
action into a tag or publication.

**Precondition:** T07 through T09 have passed locally on the final revision.

**Acceptance criteria:**

- The owner explicitly approves the push and Release Candidate workflow dispatch.
- The pushed object ID equals the locally frozen final revision.
- No source, generated file, lockfile, or workflow changes occur after local
  certification.
- No tag, npm publication, or GitHub Release is created by this task.

**Status:** Awaiting owner approval after all preceding gates pass

### T11 — Run and accept `release-candidate.yml`

**Goal:** Rebuild, recertify, and seal one immutable candidate evidence bundle
from the pushed final revision.

**Acceptance criteria:**

- Every quality, security, package, native build, Windows Desktop, Linux
  Desktop, scale, repeatability, manifest, SBOM, checksum, and provenance lane
  is green.
- macOS native builds and package checks pass, but no macOS Desktop certification
  lane or receipt exists.
- The candidate contains the exact five archives, sanitized Windows/Linux
  Desktop receipts, scale and repeat receipts, release manifest, CycloneDX 1.6
  SBOM, `SHA256SUMS`, and provenance.
- The manifest revision equals the workflow head SHA. Archive inventory, names,
  sizes, hashes, package identities, versions, certification status, and
  compatible-but-untested status match exactly.
- Windows and Linux receipts bind the same plugin archive SHA-256.
- A second fresh download directory verifies `SHA256SUMS` and provenance without
  using the build workspace.

**Verification:**

```text
gh run view <release-candidate-run-id> --repo jannotix/opencode-cycle-plugin
gh run download <release-candidate-run-id> --repo jannotix/opencode-cycle-plugin --name opencode-cycle-<version>-release-candidate --dir <fresh-candidate-directory>
```

Run the platform-appropriate SHA-256 verification command inside the downloaded
candidate and record the result. Do not assume `sha256sum` exists on Windows.

**Status:** Not started

---

## Milestone M5 — Authorize and perform public distribution

### T12 — Verify publishing authority and protected controls

**Goal:** Prepare safe first-publication authority without publishing.

**Precondition:** T11 completed and independently accepted.

**Acceptance criteria:**

- The npm scope and all five package names are controlled by the owner.
- GitHub environment `release` requires protected-branch and human approval.
- Each of the five packages is configured with the exact GitHub trusted
  publisher: repository, `publish.yml` workflow filename, `release`
  environment, and `npm publish` permission.
- GitHub environment `release` is the only authorized publication path and has
  human approval plus protected-branch controls.
- No long-lived npm publish token remains in GitHub secrets or the workflow.
- Trusted-publisher configuration, required 2FA policy, provenance, and the
  package/repository identity are checked before the publication approval.
- Local developer machines are not an authorized publication path.
- Publication order, partial-publication handling, rollback, deprecation, and
  incident contacts are rehearsed without publishing.

**Verification:**

```text
gh api repos/jannotix/opencode-cycle-plugin/environments/release
npm view opencode-cycle version --json
npm view @opencode-cycle/native-win32-x64 version --json
npm view @opencode-cycle/native-linux-x64 version --json
npm view @opencode-cycle/native-darwin-x64 version --json
npm view @opencode-cycle/native-darwin-arm64 version --json
```

`npm view` may return not found before first publication. Record that expected
state without treating it as a release-readiness failure.

**Status:** Not started

### T13 — Obtain explicit publication approval

**Goal:** Authorize only the already sealed candidate.

**Acceptance criteria:**

- The owner reviews the final SHA, Release Candidate URL, exact package and
  evidence inventory, security verdict, compatibility matrix, and rollback plan.
- Approval names version 1.0.0 and the exact final revision.
- Approval does not authorize source changes. Any requested change returns the
  release to M1 and invalidates the candidate.

**Status:** Awaiting owner approval after T12

### T14 — Publish and independently verify the public release

**Goal:** Publish only the sealed bytes and prove a clean user installation from
public distribution.

**Precondition:** explicit T13 owner approval.

**Acceptance criteria:**

- Publish all four native packages before the main plugin, using the sealed
  versions and archive bytes. Publish the main plugin last.
- Create the GitHub Release only after all npm publications succeed.
- The GitHub Release contains only the sealed distributable archives and
  allowlisted public evidence/metadata.
- Release notes list Windows x64 and Linux x64 as certified on OpenCode Desktop
  1.18.21 and macOS x64/arm64 as compatible but untested.
- Independent clean-install smoke tests pass from npm on Windows and Linux.
- Installation, update resilience, restart, setup, doctor, one bounded Full
  cycle, and uninstall are verified without patching OpenCode core or deleting
  user project files and durable Cycle state.
- Published package hashes and GitHub files match the sealed candidate.
- If any post-publication check fails, execute the rollback policy immediately.

**Verification:**

```text
gh release view v<version> --repo jannotix/opencode-cycle-plugin
npm view opencode-cycle@<version> dist.tarball version --json
npm view @opencode-cycle/native-win32-x64@<version> dist.tarball version --json
npm view @opencode-cycle/native-linux-x64@<version> dist.tarball version --json
npm view @opencode-cycle/native-darwin-x64@<version> dist.tarball version --json
npm view @opencode-cycle/native-darwin-arm64@<version> dist.tarball version --json
```

Record sanitized independent install transcripts and public package checksums in
the release evidence bundle.

**Status:** Not started

## Production verdicts

### Pre-publication verdict

`AUTHORIZED TO PUBLISH` is allowed only after T00 through T12, including T02a,
are complete, all final receipts and artifacts bind to one clean immutable revision, the remote
Release Candidate is green, and T13 records explicit owner approval. Otherwise
the verdict remains `BLOCKED`.

### Post-publication verdict

`PUBLIC RELEASE VERIFIED` is allowed only after T14 confirms the sealed public
bytes and clean Windows/Linux installations. A failed post-publication check
does not rewrite the earlier evidence; it changes the verdict to
`WITHDRAWN — ROLLBACK REQUIRED` and activates the rollback policy.
