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

### Why this table is empty — audit of 2026-09-05

The table holds no row because no row is admissible, not because rows were
forgotten. Admission needs two things and T00 through T06 have only one:
the deterministic work is implemented and its named commands pass, and no task
records an independent review of that work. T01 and T04 said so themselves
before this audit; the other six were marked `Completed` while carrying the
same gap, which is the failure this product exists to refuse — a task closed by
narrative rather than by evidence. Every status now separates the two.

What was verified deterministically on `242900f`, and what it does not settle:

| Task | Commit | Deterministic check re-run on 2026-09-05 | Result |
| --- | --- | --- | --- |
| T00 | `b7e5529` | documentation-only commit, clean tree | holds |
| T01 | `b4c2463`, `76ce38d` | `bun run check`, `cargo test --workspace --all-features`, `bun test` | pass (447/447) |
| T02 | `ca68aa3`, `317bdca`, `4797d69` | both macOS packages present, declared as exact-version optional dependencies, capabilities separates certified from compatible | holds |
| T02a | `869118b` | no `NODE_AUTH_TOKEN`/`secrets.*NPM` assignment in `publish.yml`; no `registry-url` | holds |
| T03 | `fb732a2` | last proven from a clean clone on its own commit, not re-proven here | stale |
| T04 | `b57680b` | Bun invariant suites and the three named `workflowd` binaries | pass |
| T05 | `8fa677a` | receipts on disk at `target/certification/desktop/`, both naming `bce8e8f`, both binding plugin `960b3cd9…` | present, and provisional |
| T06 | `70732b0` | `CERTIFIED_HOST_VERSIONS` is exactly `1.18.21` | holds |

A passing command is one half of admission. None of these rows may enter the
ledger until an independent reviewer has approved the same work, which is what
T06a below exists to obtain.

Two consequences follow and neither is optional:

- **T07 cannot start.** Its precondition requires M0 through M2 to be complete
  *and independently reviewed*. The second half is not met for any task.
- **The T05 receipts certify nothing for release.** They name `bce8e8f`, the
  T06 promotion invalidated them by its own terms, and the head is now
  `242900f`. They are evidence that the activation path works, not evidence
  about any candidate.

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

**Status:** Implemented; independent review open. The exact commit is the documentation-only commit that
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

**Status:** Implemented; independent review open. The R5 hardening landed at `b4c2463` but left the Windows
suite red: the module-level eager Windows reparse inspector in
`scripts/release/verified-file.ts` spawned a persistent PowerShell worker that
kept every importing process alive, so success-path linker and tool-runtime
child processes finished their work but never exited and their tests timed out.
The commit containing this status update makes the inspector lazy and
reference-counted — idle worker unreferenced so hosts can exit, pending
requests referenced so a verification cannot be silently abandoned — and
recalibrates two machine-bound test budgets (sbom cross-check to the standard
30 s, real-tree runtime-input envelope to 10 min) without weakening any
functional or security assertion; the 30 s linker bound inside the real-tree
test is unchanged. Full Bun, Rust, and check gates pass on Windows on this
commit; independent review remains open before a receipt row is added.

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
bun test packages/opencode-cycle/test/client.test.ts packages/opencode-cycle/test/capabilities.test.ts scripts/packaging/plugin-package.test.ts scripts/release/release-manifest.test.ts scripts/release/publication-plan.test.ts scripts/release/release-workflow.test.ts
```

**Status:** Implemented; independent review open. The two macOS native packages are restored as
platform-bound workspace members and declared by the plugin as exact-version
optional dependencies; the client resolves each supported target through a
literal specifier so the packaged Desktop linker still verifies the graph
statically. The Release Candidate workflow builds and package-verifies
`darwin-x64` on `macos-13` and `darwin-arm64` on `macos-15`, and its Desktop
job remains a Windows and Linux matrix with no macOS lane. Certified and
compatible-but-untested are now distinct in the release contract: the manifest
carries a separate `compatibility` array whose record type has no evidence
field at all, so an untested platform cannot hold a Desktop receipt even under
malformed input, and the manifest schema is version 2. Publication refuses to
proceed if a macOS platform is presented as certified, if a compatibility
status is upgraded, or if the untested platforms are not declared. `/cycle
doctor` capability output reports platform status and never reports certified
on an untested platform. README, user manual, getting-started guide and the
verification guide state the approved wording.

### T02a — Migrate the publish workflow to npm trusted publishing

**Goal:** Remove long-lived publish-token authentication from the release
workflow before the final source revision is frozen.

**Acceptance criteria:**

- `.github/workflows/publish.yml` publishes through GitHub Actions OIDC with
  `id-token: write`; it has no `NODE_AUTH_TOKEN` or `secrets.NPM_TOKEN` publish
  path.
- `actions/setup-node` declares no `registry-url`, so no `.npmrc` credential
  template is written into the job at all.
- The job fails closed before publishing when the OIDC request context is
  absent or any static npm credential is present in the environment or in an
  `.npmrc` reachable by the publish step.
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
if (rg -n '^\s*(NODE_AUTH_TOKEN|NPM_TOKEN)\s*:|secrets\s*\.\s*\w*NPM' .github/workflows/publish.yml) { throw 'Static npm publish token found' }
```

The second command must complete without throwing. It matches a credential
*assignment*, not the fail-closed shell assertion that proves the same variable
is empty; a blanket name search would forbid the guard that enforces the rule.

**Status:** Implemented; independent review open. `publish.yml` authenticates only through trusted
publishing: the `NODE_AUTH_TOKEN`/`secrets.NPM_TOKEN` step environment is
removed, `registry-url` is removed so setup-node writes no `_authToken`
template, and a new pre-publish step fails closed unless the OIDC request
context is present and no static credential exists in the environment or in any
reachable `.npmrc`. The release-workflow test proves each property structurally
and was verified red against the previous token-based workflow before the fix.
No package version, package, tag, or GitHub Release was created.

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

**Status:** Implemented; independent review open. A fresh clone of the execution branch installs with the
frozen lockfile and passes the static source gate, the Bun suite, and the Rust
suite. Running the gate from a clone rather than the developer worktree
surfaced two defects that a warm tree hid, both fixed here rather than waived:
the packed real-tree proof performed a full optimized Rust build inside its own
budget, so on a cold tree it timed out — the build is now environment
preparation in `beforeAll` and the proof keeps a budget that means something;
and the same proof pinned an exact `graphSha256`, which necessarily covers the
native binary as a verified asset, so it could only pass where those binary
bytes were reproduced. An optimized Rust build is not byte-reproducible across
build directories, so that expectation could never have held on a CI runner or
a second machine. Drift detection now rests on the reproducible file counts,
module kinds and suppressed-optional-root count, and the digest is still
required to be well formed and bound into the receipt.

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
cargo test -p workflow-store --test verification --test workflow_persistence
cargo test -p workflowd --test verification_contract --test verification_runner --test windows_verification_job
```

The Rust commands name their test binaries. The earlier `cargo test -p
<crate> verification` form filtered on test *function* names: in
`workflow-store` no function carries that word, so the command selected zero
tests and still exited zero, and in `workflowd` it silently skipped the three
dedicated verification binaries. A gate that passes without executing anything
is not evidence.

**Status:** Implemented; independent review open. On the current revision the Bun invariant suites pass
30 of 30. The corrected Rust commands execute 8 tests in `workflow-store`,
including `verified_task_closure_is_atomic_payload_bound_and_advances_dependents`,
and 13 tests across the three `workflowd` verification binaries. The previous
command form was replaced rather than waived; independent review remains open
before a receipt row is added.

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

**Status:** Implemented; independent review open. Both provisional proofs pass. The rejecting check was
`validateDesktopPluginInput`, with the archive binding and the options both
correct. OpenCode Desktop reports a filesystem root as the worktree when no
project is open, and the check read any outside-scratch worktree as an escape.
A root carries no path out of the sandbox, so the refusal was wrong; the fix
separates the two conditions rather than loosening the control, and an outside
worktree or an outside directory is still refused.

Desktop offers no supported way to be launched at a directory, so it does not
open the isolated project this harness prepares. Until that exists upstream,
these proofs establish activation, control-plane protocol, daemon identity,
authenticated shutdown and final process absence, and they do not establish
project-scoped behaviour. The live acceptance matrix in T09 remains the place
that covers it.

Receipts on revision `bce8e8f1dec88cc5e4dcdfbc8460f0d68b3ddbc2`:

| Platform | Plugin SHA-256 | Native SHA-256 | Authenticity |
| --- | --- | --- | --- |
| windows-x64 | `960b3cd9…` | `8b51bf04…` | Authenticode, verified |
| linux-x64 | `960b3cd9…` | `4ae7a30f…` | SHA-256, verified |

Both bind the same canonical plugin archive built once on the Linux lane, as
the release contract requires. Both record eleven passing load stages, a
terminated daemon with authenticated shutdown and final process absence. These
remain provisional: they certify no revision for release purposes and are
invalidated by the T06 host-policy commit.

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

**Status:** Implemented; independent review open. The work landed in the commit carrying this status update. Certification
now follows the evidence: `CERTIFIED_HOST_VERSIONS` is exactly `1.18.21`, the
only host with Desktop receipts on this revision. The compatibility floor is
unchanged at 1.18.16, so 1.18.16 through 1.18.20 keep running as compatible
historical hosts and report plainly that they are outside the certified
evidence set, rather than carrying a claim their evidence no longer supports.
The getting-started guide was the last place still presenting 1.18.16 and
1.18.18 as current release evidence and now states the same thing.

Promotion invalidates the T05 provisional receipts for final release purposes:
they were produced on `bce8e8f`, before this commit, and only the final frozen
revision in T07 through T09 can carry release certification.

Two consequences of the promotion were corrected rather than papered over. The
Desktop-certification registration test now activates on the certified host
instead of 1.18.16, and the uncertified activation path — a warning naming the
certified evidence, which is what most 1.x hosts now take — had no coverage at
all and gained a test. The packed real-tree byte counts moved by exactly the
362 bytes that `dist/capabilities.js` grew, measured against a build of the
previous source rather than assumed.

### T06a — Obtain the independent review M1 and M2 never received

**Goal:** Supply the second half of the task-completion invariant for T00
through T06, so the receipt ledger can hold rows and T07 can begin.

**Why this task exists:** the audit of 2026-09-05 found eight tasks whose
deterministic verifiers pass and whose independent review never happened. The
release contract makes that review a condition of closure, and T07 makes it a
precondition of the frozen revision. Without it the ledger stays empty and M3
cannot legitimately start.

**Acceptance criteria:**

- A reviewer who did not implement the work reviews each of T00 through T06
  against its own acceptance criteria and its named verification commands, on
  the revision that task landed on.
- The reviewer re-runs the named commands rather than accepting a recorded
  result, and states for each task whether it passes, and on which revision.
- Any task the review rejects returns to M1 or M2 and its status says so.
- Each accepted task gains one receipt ledger row naming commit, command,
  receipt path and verdict.
- The reviewer is recorded. An agent that wrote or modified the work under
  review is not an independent reviewer of it, and neither is the owner acting
  as the implementer.

**Verification:**

```text
bun run check
bun test
cargo test --workspace --all-features
git status --short
git rev-parse HEAD
```

**Status:** Not started. Blocks T07.

---

## Milestone M2b — Integrate what the Claude Code port learned in 1.0.18 through 1.0.24

**Why this milestone exists:** between 2026-09-06 and 2026-09-08 the Claude Code port
shipped seven releases. Three fix defects in the governed cycle that were found by
running a real certification, not by reading code, and the first of them is present
byte for byte in this repository's `crates/workflowd/src/lifecycle.rs`. Every task
below changes source, so all of it lands before T07 freezes the revision. Nothing is
frozen yet, so no receipt is invalidated; T06a reviews this milestone together with
M1 and M2, once.

`workflowd`, `workflow-code-intel` and `workflow-store` are shared with the Zcode
port. A Rust change here is written once and carried there in the same round.

### N1 — A reviewer's rejection binds, and a contradicting approval is recorded

**Status:** Implemented at `4176221`; independent review open. The verdict is saved
verbatim, the chain records `arbitration_refused` with the rejecting role and the
target, and the run is routed to repair there. Four tests in
`crates/workflowd/tests/arbitration.rs` cover it, including the property that makes
recording an Approved verdict safe: a refused approval reaches neither the delivery
state nor holds the candidate, so promotion is impossible. Removing the binding
fails three of them, and fails closed. The Zcode copy of the function is unchanged
and still carries the defect.

**Defect:** `submit_arbitration` returns `Err("approval requirements have not passed")`
when the arbiter approves over a rejecting review, before `save_arbitration_once` runs.
No arbitration row, no audit event, and the orchestrator re-dispatches the arbiter with
the same prompt, which yields the same verdict. This is the defect Claude Code 1.0.20
describes as "twice, twenty-one agents, and no trace in the record".

**Acceptance criteria:**

- An approval that contradicts a live rejection is saved verbatim, refused by name in
  the audit chain (`arbitration_refused`, naming the rejecting role or roles), and
  routed to repair toward the target the rejecting review asked for: `architecture`
  if either review asked for it, otherwise `execution`.
- An approval over a failing mandatory gate keeps its current handling.
- One dispatch converges: the orchestrator does not re-run the arbiter on the same
  candidate.
- The same change is applied to the Zcode copy of `lifecycle.rs`.

**Verification:**

```text
cargo test -p workflowd --test lifecycle
bun test packages/opencode-cycle/test/full-workflow.test.ts
```

**Status:** Not started

### N2 — The repair is told what the reviewer objected to

**Status:** Implemented at `eee9f94`; independent review open. Closing N1 had opened
a second gap in the same place: the run read the arbiter's decision to choose its
next step, so a refused approval ended it at execution with the repair never driven.
The route now comes from the state the plane reports. Repair feedback carries the
findings of every review that rejected, plus the arbiter's own only when it rejected,
in the orchestrator and in the recovery context alike, with the verdict still the
fallback when nothing carries a finding. The full-workflow suite gained the scenario
that only exists after a binding rejection, and keying the route back on the verdict
fails it; the recovery test asserts the reviewer's summary reaches the repair, and
emptying the refusals fails it. Bun suite 448 of 448.

**Defect:** repair feedback is the arbiter's verdict alone
(`packages/opencode-cycle/src/orchestration/full-workflow.ts`, and the recovery
context in `crates/workflowd/src/control.rs`). After N1 a refused approval carries no
finding of its own, so the executor is sent into repair against an objection it has
to rediscover.

**Acceptance criteria:**

- Repair feedback is the findings of every review that rejected, plus the arbiter's
  findings only when the arbiter rejected.
- The recovery context reports the same feedback for a workflow resumed at repair.
- The 64 KiB recovery limit on repair feedback is unchanged.

**Verification:**

```text
cargo test -p workflowd --test control
bun test packages/opencode-cycle/test/full-workflow.test.ts packages/opencode-cycle/test/retry-recovery.test.ts
```

**Status:** Not started

### N3 — The arbiter prompt states the binding rule

**Acceptance criteria:** the full-mode arbiter prompt says that a rejection by either
reviewer binds, and that disagreeing means rejecting with a repair target and the
reasoning on record. Quick mode is unchanged.

**Verification:**

```text
bun test packages/opencode-cycle/test/arbiter.test.ts
```

**Status:** Not started

### N4 — Required-missing gates key on the candidate's changed files

**Defect:** `crates/workflowd/src/verification/plan.rs` matches the layer rules
against the architect's declared `write_scopes`. A scope of `src/` covers
`src/db/migrations/x.sql` without inserting the database gate. This predates the
Claude Code comparison; that port matched on changed files from the start.

**Acceptance criteria:**

- The rules are matched against the union of the declared scopes and the paths in the
  frozen candidate manifest. Adding paths can only insert gates.
- A candidate touching a `.sql` file under a non-database scope receives
  `database:real-integration`.

**Verification:**

```text
cargo test -p workflowd --test verification_contract
```

**Status:** Not started

### N5 — Reach: the rules also match what a change reaches

**Acceptance criteria:**

- Given the changed paths, the verification stage computes the files the change
  reaches through `workflow_code_intel::query::impact` (incoming, depth 2, node ceiling
  the larger of 200 and ten percent of indexed files) and adds them to the set of N4.
- Files in a language the graph has no grammar for are reported as outside the model,
  not as unresolved.
- A project that was never indexed, or a changed file the index does not hold, yields
  `impact:unresolved` naming the reason and `/cycle index` as the remedy. That record
  is mandatory only under `strict` strictness.
- A reach past the ceiling yields `impact:high-fan-in` as a warning naming the touched
  symbols with the most consumers, and inserts no gate.
- A resolved reach records `impact:unresolved` as passed with the reached count.

**Verification:**

```text
cargo test -p workflow-code-intel
cargo test -p workflowd --test verification_contract --test verification_runner
```

**Status:** Not started. Depends on N4.

### N6 — Retention: report and prune retained candidate bytes

**Acceptance criteria:**

- `limits usage` reports retained payload bytes and files, the prunable subset
  belonging to workflows in `cancelled` or `completed`, and record counts.
- `limits prune` without `confirm` reports what it would free and changes nothing;
  with `confirm` it nulls the payload of those candidates' files and nothing else.
  Rows, digests, evidence and history are untouched, and `history verify` stays green.
- A workflow in any non-terminal state is never pruned.
- `docs/commands/reference.md` and the user manual describe both operations, and
  `bun run check:commands` passes.

**Verification:**

```text
cargo test -p workflow-store
cargo test -p workflowd --test control
bun run check:commands
```

**Status:** Not started

### N7 — The repair-attempt bound comes from the control plane

**Defect:** `full-workflow.ts` bounds architecture attempts with a literal `5` while
`status` already reports `maximumRepairCycles`.

**Acceptance criteria:** the bound is read from status; `5` applies only when the
field did not arrive, and the effective bound is logged.

**Status:** Not started

### N8 — The delegation deny does not hang on one host permission key

**Defect:** `permissions.ts` sets `result.task = "deny"`. If the host renames that
key the deny stops applying silently, which is how the Claude Code port's subagent
boundary stopped enforcing anything in 1.0.17.

**Acceptance criteria:** capability negotiation checks that the key governing child
sessions is one this build denies, `doctor` warns when it is not, and a test asks for
delegation under every known name.

**Status:** Not started

### N10 — The packed-tree gate resolves dependencies without a lockfile

**Defect found on 2026-09-12 while closing N1.** `desktop-runtime-input-real.test.ts`
extracts the packed plugin and runs `bun install` inside it. The extracted package
carries `dist`, `LICENSE`, `NOTICE` and its manifest — no lockfile — so every
dependency is resolved fresh. `puppeteer-core@25.6.0` declares `ws` as `^8.21.1`
and `typed-query-selector` as `^2.12.2`, and both ship JavaScript, which is exactly
what `runtimeInputContentBytes` counts.

The pinned totals therefore drift with the registry rather than with this
repository. They moved from 25,574,559 to 25,610,827 between 2026-09-04 and
2026-09-12 with no change to any shipped file: removing the whole of N1 from the
worktree reproduces the new number exactly, which is how it was isolated.

This matters beyond one assertion. The release contract requires clean-clone gates
with locked dependencies, and this gate is time-dependent: it can fail on a
revision that was green yesterday, and it can pass on a candidate whose dependency
graph nobody pinned.

**Acceptance criteria:**

- The proof asserts no value that the registry can move. What it pins is a property
  of this repository.
- Drift detection on shipped code survives: a change to the JavaScript this package
  ships still fails the proof.
- The third-party share stays bounded rather than unchecked.
- The pins are not bumped to whatever today's registry returns.

**Verification:**

```text
bun test scripts/ci/desktop-runtime-input-real.test.ts
```

**Status:** Implemented at `eb28156`; independent review open.

Installing from a lockfile — the first acceptance criterion this task carried — was
investigated and is not available. The workspace lockfile describes a workspace and
`bun` refuses it in a single-package directory, and the proof also installs the
native archive from a path that differs on every run, which no frozen lockfile can
hold. The criteria above replace it.

The proof now sums the bytes under `dist/` and pins that, leaving the third-party
share to the bounds the block already asserted: under 3,000 runtime-input files,
under 64 MiB serialized, and smaller than the full tree. That is the distinction the
graph digest in the same assertion already carried, applied to the same class of
value. Measured at 2,303,378 bytes; thirty-five bytes added to a shipped source file
moved it by exactly thirty-five and failed the test, which is what makes it drift
detection rather than a constant.

With this the Bun suite is 447 of 447 on `eb28156`.

### N9 — Verifications that need a test, not a port

- Recovery from `delivery`: a promotion that never began is finished; one that ran and
  aborted is rolled back and left to a person. Test both in `retry-recovery.test.ts`.
- A failed inventory leaves the previous graph partition readable. Confirm the
  existing test or add one.
- The entrypoint session cannot call `edit`. Confirm the existing test or add one.
- State in `docs/guides/operations-and-recovery.md` that delivery promotes exact bytes
  and never commits, so nobody looks for a commit message.

**Status:** Not started

Not carried over, by design: the "commit rests on N gates" fix (this product does not
commit), the indexer fallback removal (one ignore policy already), the run-by-hand
refusal (the entrypoint has no editing tools), and the ZIP timestamp fix (tgz, packed
twice and compared, built once on the Linux lane).

---

## Milestone M3 — Certify one immutable final revision

### T07 — Freeze the revision and run clean-clone product gates

**Goal:** Establish one immutable source revision for every final receipt and
artifact.

**Precondition:** M0 through M2 are complete, independently reviewed, committed,
and clean. As of 2026-09-05 the review half is outstanding for every task in M1
and M2; T06a obtains it, and until T06a closes this task cannot start. As of
2026-09-12 M2b must also be complete first: every task in it changes source, and a
source change after the freeze creates a new candidate.

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
