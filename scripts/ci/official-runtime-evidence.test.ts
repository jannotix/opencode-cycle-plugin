import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  desktopDependencyContentTreeSha256,
  serializeDesktopDependencyTreeManifest,
} from "./desktop-dependency-tree.js"
import {
  OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX,
  openOfficialRuntimeEvidenceDirectory,
  serializeOfficialRuntimeProvenance,
  validateOfficialRuntimeEvidenceDirectory,
  type OfficialGateOutputSummary,
  type OfficialRuntimeEvidenceBinding,
} from "./official-runtime-evidence.js"

test("official evidence target rejects existing, nonempty, linked and nested directories", async () => {
  const empty = evidencePath("existing-empty")
  const nonempty = evidencePath("existing-nonempty")
  const linked = evidencePath("linked")
  const linkTarget = await mkdtemp(join(tmpdir(), "cycle-official-evidence-link-target-"))
  const nestedParent = await mkdtemp(join(tmpdir(), "cycle-official-evidence-nested-parent-"))
  try {
    await mkdir(empty)
    await mkdir(nonempty)
    await writeFile(join(nonempty, "existing"), "existing")
    await symlink(linkTarget, linked, process.platform === "win32" ? "junction" : "dir")
    await expect(openOfficialRuntimeEvidenceDirectory(empty)).rejects.toThrow("exists")
    await expect(openOfficialRuntimeEvidenceDirectory(nonempty)).rejects.toThrow("exists")
    await expect(openOfficialRuntimeEvidenceDirectory(linked)).rejects.toThrow("exists")
    await expect(openOfficialRuntimeEvidenceDirectory(join(
      nestedParent,
      `${OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX}outside`,
    ))).rejects.toThrow("boundary")
  } finally {
    await Promise.all([
      rm(empty, { force: true, recursive: true }),
      rm(nonempty, { force: true, recursive: true }),
      rm(linked, { force: true, recursive: true }),
      rm(linkTarget, { force: true, recursive: true }),
      rm(nestedParent, { force: true, recursive: true }),
    ])
  }
}, { timeout: 60_000 })

test("throw, runtime failures and post-runtime publication each leave complete durable evidence", async () => {
  for (const [label, errorClass, runtime, runtimePassed] of [
    ["throw-before-runtime", "package_error", false, false],
    ["runtime-timeout", "timeout", true, false],
    ["runtime-output-limit", "output_limit", true, false],
    ["post-runtime-publication", "evidence_publication", true, true],
    ["host-proof-timeout", "host_proof", true, true],
  ] as const) {
    const path = evidencePath(label)
    try {
      const session = await openOfficialRuntimeEvidenceDirectory(path)
      await session.recordStage("gate-started", { revision: "c".repeat(40) })
      if (runtime) {
        await session.recordStage("module-graph-prepared", runtimeInputPrepared())
        await session.recordStage("runtime-started", runtimeStarted())
        await session.recordStage("runtime-completed", runtimeCompleted(
          runtimePassed ? "none" : errorClass,
        ))
        if (runtimePassed) {
          await session.recordStage("runtime-guard-passed")
          await session.recordStage("evidence-material-preparing")
          if (errorClass === "host_proof") {
            await session.recordStage("host-proof-started")
            await session.recordStage("host-proof-failed", {
              errorCode: "HOST_RESULT_TIMEOUT",
              exitCode: 143,
              resultPresent: false,
              timedOut: true,
            })
          }
        }
      }
      const publication = await session.finalizeFailure({
        errorClass,
        errorDigest: digest(Buffer.from(label)),
        gateOutput: failedOutput(),
        revision: "c".repeat(40),
      })
      expect(publication.passed).toBe(false)
      await expect(validateOfficialRuntimeEvidenceDirectory(path)).resolves.toBeUndefined()
      const exit = JSON.parse(await readFile(join(path, "package-gate-exit.json"), "utf8"))
      expect(exit).toMatchObject({ errorClass, passed: false, status: "failed" })
    } finally {
      await rm(path, { force: true, recursive: true })
    }
  }
}, { timeout: 180_000 })

test("partial success publication becomes durable evidence_publication failure", async () => {
  const path = evidencePath("partial")
  try {
    const session = await openOfficialRuntimeEvidenceDirectory(path)
    await session.recordStage("gate-started")
    await writeFile(join(path, "desktop-runtime-provenance.json"), "collision")
    const publication = await session.publish({
      binding: binding(),
      gateOutput: emptyOutput(),
      material: material(),
    })
    expect(publication.passed).toBe(false)
    await expect(validateOfficialRuntimeEvidenceDirectory(path)).resolves.toBeUndefined()
    const exit = JSON.parse(await readFile(join(path, "package-gate-exit.json"), "utf8"))
    expect(exit).toMatchObject({ errorClass: "evidence_publication", passed: false })
  } finally {
    await rm(path, { force: true, recursive: true })
  }
}, { timeout: 60_000 })

test("postwrite schema failure replaces tentative success metadata with durable failure", async () => {
  const path = evidencePath("postwrite-schema")
  try {
    const session = await openOfficialRuntimeEvidenceDirectory(path)
    await session.recordStage("gate-started")
    const invalid = material()
    const receipt = JSON.parse(invalid["runtime-receipt.json"].toString("utf8"))
    receipt.schemaVersion = 3
    const publication = await session.publish({
      binding: binding(),
      gateOutput: emptyOutput(),
      material: {
        ...invalid,
        "runtime-receipt.json": Buffer.from(`${JSON.stringify(receipt)}\n`),
      },
    })
    expect(publication.passed).toBe(false)
    await expect(validateOfficialRuntimeEvidenceDirectory(path)).resolves.toBeUndefined()
    const exit = JSON.parse(await readFile(join(path, "package-gate-exit.json"), "utf8"))
    expect(exit).toMatchObject({ errorClass: "evidence_publication", passed: false })
  } finally {
    await rm(path, { force: true, recursive: true })
  }
}, { timeout: 60_000 })

test("successful official evidence is durable, exact, path-free and cleanup-independent", async () => {
  const path = evidencePath("success")
  const internalScratch = await mkdtemp(join(tmpdir(), "cycle-official-internal-scratch-"))
  try {
    const session = await openOfficialRuntimeEvidenceDirectory(path)
    const evidence = material()
    await session.recordStage("gate-started", { revision: "c".repeat(40) })
    await session.recordStage("module-graph-prepared", runtimeInputPrepared())
    await session.recordStage("runtime-started", runtimeStarted())
    await session.recordStage("runtime-completed", runtimeCompleted("none"))
    await recordEvidenceMaterial(session, evidence)
    const publication = await session.publish({
      binding: binding(),
      gateOutput: emptyOutput(),
      material: evidence,
    })
    expect(publication).toMatchObject({
      evidenceManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      exitReceiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      passed: true,
      path,
    })
    await rm(internalScratch, { force: true, recursive: true })
    await expect(validateOfficialRuntimeEvidenceDirectory(path)).resolves.toBeUndefined()
    const retainedNames = await readdir(path)
    expect(retainedNames).toContain("desktop-runtime-provenance.json")
    expect(retainedNames).not.toContain("candidate-entry.js")
    expect(retainedNames).not.toContain("candidate-wrapper.js")
    expect(retainedNames).not.toContain("desktop-runtime-linker.mjs")
    for (const name of retainedNames) {
      const content = await readFile(join(path, name))
      const text = content.toString("utf8")
      expect(text, name).not.toContain(internalScratch)
      expect(text, name).not.toMatch(/[A-Za-z]:[\\/]/u)
      expect(text, name).not.toContain("file://")
    }
    for (const name of ["evidence-manifest.json", "package-gate-exit.json"]) {
      const receipt = await readFile(join(path, name), "utf8")
      expect(receipt).not.toContain(path)
      expect(receipt).not.toMatch(/nonce|secret|token/iu)
    }
  } finally {
    await Promise.all([
      rm(path, { force: true, recursive: true }),
      rm(internalScratch, { force: true, recursive: true }),
    ])
  }
}, { timeout: 120_000 })

test("official evidence scans every durable byte against exact secrets and local paths", async () => {
  const path = evidencePath("sensitive-material")
  const nonce = "9".repeat(64)
  const scratch = join(tmpdir(), `cycle-sensitive-${randomUUID()}`)
  const configPath = join(scratch, "config", "opencode.json")
  try {
    const session = await openOfficialRuntimeEvidenceDirectory(path, {
      absolutePaths: [scratch, configPath],
      nonce,
    })
    await session.recordStage("gate-started")
    await session.recordStage("module-graph-prepared", runtimeInputPrepared())
    await session.recordStage("runtime-started", runtimeStarted())
    await session.recordStage("runtime-completed", runtimeCompleted("none"))
    const evidence = material()
    await recordEvidenceMaterial(session, evidence)
    const diagnostics = Buffer.from(`${JSON.stringify({
      detail: `binding=${nonce}; config=${configPath}`,
      runDigest: "1".repeat(64),
      schemaVersion: 2,
      sequence: 0,
      stage: "certification_env_prepared",
      status: "passed",
      type: "opencode-cycle-desktop-load-diagnostic",
    })}\n`)
    const publication = await session.publish({
      binding: binding(),
      gateOutput: emptyOutput(),
      material: {
        ...evidence,
        "desktop-runtime-diagnostics.jsonl": diagnostics,
      },
    })
    expect(publication.passed).toBe(false)
    const retainedNames = await readdir(path)
    for (const name of retainedNames) {
      const content = await readFile(join(path, name))
      const text = content.toString("utf8")
      expect(text, name).not.toContain(nonce)
      expect(text, name).not.toContain(scratch)
      expect(text, name).not.toContain(configPath)
      expect(text, name).not.toMatch(/[A-Za-z]:[\\/]/u)
    }
    await expect(validateOfficialRuntimeEvidenceDirectory(path)).resolves.toBeUndefined()
  } finally {
    await rm(path, { force: true, recursive: true })
  }
}, { timeout: 120_000 })

test("official evidence validation rejects obsolete filenames and stale schemas", async () => {
  const oldName = evidencePath("old-name")
  const oldSchema = evidencePath("old-schema")
  try {
    const first = await successfulSession(oldName)
    await first.publish({ binding: binding(), gateOutput: emptyOutput(), material: material() })
    await rename(
      join(oldName, "desktop-runtime-result.json"),
      join(oldName, "windows-runtime-result.json"),
    )
    await expect(validateOfficialRuntimeEvidenceDirectory(oldName)).rejects.toThrow("filenames")

    const second = await successfulSession(oldSchema)
    await second.publish({ binding: binding(), gateOutput: emptyOutput(), material: material() })
    const receipt = JSON.parse(await readFile(join(oldSchema, "runtime-receipt.json"), "utf8"))
    receipt.schemaVersion = 3
    await writeFile(join(oldSchema, "runtime-receipt.json"), `${JSON.stringify(receipt)}\n`)
    await expect(validateOfficialRuntimeEvidenceDirectory(oldSchema)).rejects.toThrow(/schema|digest/)
  } finally {
    await Promise.all([
      rm(oldName, { force: true, recursive: true }),
      rm(oldSchema, { force: true, recursive: true }),
    ])
  }
}, { timeout: 300_000 })

async function successfulSession(path: string) {
  const session = await openOfficialRuntimeEvidenceDirectory(path)
  await session.recordStage("gate-started")
  await session.recordStage("module-graph-prepared", runtimeInputPrepared())
  await session.recordStage("runtime-started", runtimeStarted())
  await session.recordStage("runtime-completed", runtimeCompleted("none"))
  await recordEvidenceMaterial(session, material())
  return session
}

async function recordEvidenceMaterial(
  session: Awaited<ReturnType<typeof openOfficialRuntimeEvidenceDirectory>>,
  evidence: ReturnType<typeof material>,
): Promise<void> {
  const manifest = evidence["dependency-tree-manifest.json"]
  await session.recordStage("runtime-guard-passed")
  await session.recordStage("evidence-material-preparing")
  await session.recordStage("evidence-material-prepared", {
    dependencyManifestBytes: manifest.byteLength,
    dependencyManifestSha256: digest(manifest),
  })
  await session.recordStage("host-daemon-endpoint-prepared", {
    endpointKind: "named_pipe",
    endpointPathBytes: 0,
  })
  await session.recordStage("host-proof-started")
  for (const [sequence, stage] of [
    "certification-env-prepared",
    "config-tree-prepared",
    "config-path-discovered",
    "plugin-specifier-resolved",
    "effective-env-validated",
    "candidate-module-resolved",
    "plugin-entry-started",
    "plugin-entry-completed",
    "daemon-identity-published",
  ].entries()) {
    await session.recordStage(`host-${stage}`, { sequence, status: "passed" })
  }
  await session.recordStage("host-activation-finalized", { markerPresent: true })
  await session.recordStage("host-authenticated-shutdown", {
    exitMarkerPublished: true,
    markerPublished: true,
    shutdownAuthenticated: true,
    terminated: true,
  })
  await session.recordStage("host-daemon-absent", { processAbsent: true })
  await session.recordStage("host-proof-completed")
}

function runtimeInputPrepared() {
  return {
    fullTreeFileCount: 4,
    fullTreeSerializedBytes: 400,
    inputPreparationDurationMillis: 5,
    runtimeInputContentBytes: 100,
    runtimeInputFileCount: 3,
    runtimeInputSerializedBytes: 200,
    runtimeInputSha256: "6".repeat(64),
  }
}

function runtimeStarted() {
  return { runtimePid: 4242, timeoutMillis: 30_000 }
}

function runtimeCompleted(errorClass: "none" | "output_limit" | "runtime_exit" | "timeout") {
  const empty = digest(Buffer.alloc(0))
  return {
    durationMillis: 25,
    errorClass,
    exitCode: errorClass === "none" ? 0 : 1,
    outputExceeded: errorClass === "output_limit",
    stderrBytes: 0,
    stderrSha256: empty,
    stdoutBytes: 0,
    stdoutSha256: empty,
    timedOut: errorClass === "timeout",
  }
}

function evidencePath(label: string): string {
  return join(tmpdir(), `${OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX}${label}-${randomUUID()}`)
}

function binding(): OfficialRuntimeEvidenceBinding {
  return {
    electronVersion: "42.3.3",
    nativePackageSha256: "a".repeat(64),
    nodeVersion: "24.15.0",
    pluginPackageSha256: "b".repeat(64),
    revision: "c".repeat(40),
    runtimeExecutableSha256: "d".repeat(64),
    runtimeProductVersion: "1.18.21.0",
  }
}

function emptyOutput(): OfficialGateOutputSummary {
  return {
    stderrBytes: 0,
    stderrSha256: digest(Buffer.alloc(0)),
    stderrTruncated: false,
    stdoutBytes: 0,
    stdoutSha256: digest(Buffer.alloc(0)),
    stdoutTruncated: false,
  }
}

function failedOutput(): OfficialGateOutputSummary {
  return {
    stderrBytes: 12,
    stderrSha256: digest(Buffer.from("stderr-data")),
    stderrTruncated: false,
    stdoutBytes: 12,
    stdoutSha256: digest(Buffer.from("stdout-data")),
    stdoutTruncated: false,
  }
}

function material() {
  const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`)
  const candidate = Buffer.from("export default true\n")
  const wrapper = Buffer.from("export { default } from './candidate-entry.js'\n")
  const linker = Buffer.from("export default true\n")
  const dependencyTreeSha256 = "4".repeat(64)
  const graphSha256 = "5".repeat(64)
  const identity = {
    changedNanoseconds: "1000000",
    device: "1",
    inode: "2",
    linkCount: "1",
    mode: "33188",
    modifiedNanoseconds: "1000000",
    size: "20",
  }
  const contentFiles = [
    { identity, path: "dist/index.js", sha256: "f".repeat(64) },
    { identity, path: "node_modules/a/index.js", sha256: "1".repeat(64) },
    { identity, path: "node_modules/a/package.json", sha256: "2".repeat(64) },
    { identity, path: "package.json", sha256: "3".repeat(64) },
  ]
  const contentTreeSha256 = desktopDependencyContentTreeSha256(contentFiles)
  const dependencyTree = {
    dependencyFileCount: 2,
    dependencyPackageCount: 1,
    dependencyTotalBytes: 40,
    dependencyTreeSha256,
    schemaVersion: 1 as const,
  }
  const candidateEntrySha256 = digest(candidate)
  const linkerSha256 = digest(linker)
  const loaderSha256 = digest(wrapper)
  const result = {
    candidateEntrySha256,
    dependencyTreeSha256,
    electronVersion: "42.3.3",
    fullTreeFileCount: 4,
    graphFileCount: 3,
    graphSha256,
    isolatedRuntimeBoundaryCount: 1,
    isolatedRuntimeBoundarySha256: "7".repeat(64),
    moduleLoadingProof: "static-literal-plugin-host-with-isolated-worker-v1",
    linkedEsmModuleCount: 2,
    nodeVersion: "24.15.0",
    runtimeInputContentBytes: 100,
    runtimeInputFileCount: 3,
    runtimeInputSerializedBytes: 200,
    runtimeInputSha256: "6".repeat(64),
    runtimeExecutableSha256: "d".repeat(64),
    runtimeProductVersion: "1.18.21.0",
    schemaVersion: 4,
    unverifiedPluginHostModuleLoadingRejected: true,
    suppressedOptionalRootCount: 1,
    type: "opencode-cycle-desktop-module-link",
    verifiedAssetFileCount: 1,
    verifiedCommonJsModuleCount: 0,
    verifiedContentTreeSha256: contentTreeSha256,
    verifiedJsonModuleCount: 0,
  }
  const receipt = {
    candidateEntrySha256,
    dependencyTreeSha256,
    electronVersion: "42.3.3",
    fullTreeFileCount: 4,
    graphFileCount: 3,
    graphSha256,
    linkedEsmModuleCount: 2,
    linkerSha256,
    loaderSha256,
    isolatedRuntimeBoundaryCount: 1,
    isolatedRuntimeBoundarySha256: "7".repeat(64),
    moduleLoadingProof: "static-literal-plugin-host-with-isolated-worker-v1",
    nativePackageSha256: "a".repeat(64),
    nodeVersion: "24.15.0",
    pluginPackageSha256: "b".repeat(64),
    revision: "c".repeat(40),
    runtimeInputContentBytes: 100,
    runtimeInputFileCount: 3,
    runtimeInputSerializedBytes: 200,
    runtimeInputSha256: "6".repeat(64),
    runtimeExecutableSha256: "d".repeat(64),
    runtimeProductVersion: "1.18.21.0",
    schemaVersion: 6,
    unverifiedPluginHostModuleLoadingRejected: true,
    suppressedOptionalRootCount: 1,
    type: "opencode-cycle-desktop-runtime-guard",
    verifiedAssetFileCount: 1,
    verifiedCommonJsModuleCount: 0,
    verifiedContentTreeSha256: contentTreeSha256,
    verifiedJsonModuleCount: 0,
  }
  return {
    "dependency-tree-manifest.json": serializeDesktopDependencyTreeManifest({
      contentTreeSha256,
      dependencyTree,
      files: contentFiles,
    }),
    "desktop-runtime-diagnostics.jsonl": json({
      runDigest: "1".repeat(64),
      schemaVersion: 2,
      sequence: 0,
      stage: "certification_env_prepared",
      status: "passed",
      type: "opencode-cycle-desktop-load-diagnostic",
    }),
    "desktop-runtime-provenance.json": serializeOfficialRuntimeProvenance({
      candidateEntry: candidate,
      linker,
      loader: wrapper,
    }),
    "desktop-runtime-result.json": json(result),
    "runtime-output-summary.json": json({
      exitCode: 0,
      outputExceeded: false,
      schemaVersion: 1,
      stderrBytes: 0,
      stderrSha256: digest(Buffer.alloc(0)),
      stdoutBytes: 0,
      stdoutSha256: digest(Buffer.alloc(0)),
      timedOut: false,
      type: "opencode-cycle-official-electron-runtime-output",
    }),
    "runtime-receipt.json": json(receipt),
  } as const
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
