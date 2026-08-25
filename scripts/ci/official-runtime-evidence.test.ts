import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX,
  openOfficialRuntimeEvidenceDirectory,
  validateOfficialRuntimeEvidenceDirectory,
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

test("partial evidence publication cleans every task-owned artifact and final directory", async () => {
  const path = evidencePath("partial")
  const session = await openOfficialRuntimeEvidenceDirectory(path)
  await writeFile(join(path, "desktop-runtime-linker.mjs"), "collision")
  await expect(session.publish({ binding: binding(), material: material() })).rejects.toThrow(
    /exists|published/,
  )
  expect(await access(path).then(() => true, () => false)).toBe(false)
}, { timeout: 60_000 })

test("successful official evidence is durable, exact, path-free and not removed by cleanup", async () => {
  const path = evidencePath("success")
  try {
    const session = await openOfficialRuntimeEvidenceDirectory(path)
    const publication = await session.publish({ binding: binding(), material: material() })
    expect(publication).toMatchObject({
      evidenceManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      exitReceiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      path,
    })
    await session.abort()
    await expect(validateOfficialRuntimeEvidenceDirectory(path)).resolves.toBeUndefined()
    expect(await access(path).then(() => true, () => false)).toBe(true)
    for (const name of ["evidence-manifest.json", "package-gate-exit.json"]) {
      const receipt = await readFile(join(path, name), "utf8")
      expect(receipt).not.toContain(path)
      expect(receipt).not.toMatch(/nonce|secret|token/iu)
    }
  } finally {
    await rm(path, { force: true, recursive: true })
  }
}, { timeout: 60_000 })

test("official evidence validation rejects obsolete filenames and stale schemas", async () => {
  const oldName = evidencePath("old-name")
  const oldSchema = evidencePath("old-schema")
  try {
    const first = await openOfficialRuntimeEvidenceDirectory(oldName)
    await first.publish({ binding: binding(), material: material() })
    await rename(
      join(oldName, "desktop-runtime-result.json"),
      join(oldName, "windows-runtime-result.json"),
    )
    await expect(validateOfficialRuntimeEvidenceDirectory(oldName)).rejects.toThrow("filenames")

    const second = await openOfficialRuntimeEvidenceDirectory(oldSchema)
    await second.publish({ binding: binding(), material: material() })
    const receipt = JSON.parse(await readFile(join(oldSchema, "runtime-receipt.json"), "utf8"))
    receipt.schemaVersion = 3
    await writeFile(join(oldSchema, "runtime-receipt.json"), `${JSON.stringify(receipt)}\n`)
    await expect(validateOfficialRuntimeEvidenceDirectory(oldSchema)).rejects.toThrow("schema")
  } finally {
    await Promise.all([
      rm(oldName, { force: true, recursive: true }),
      rm(oldSchema, { force: true, recursive: true }),
    ])
  }
}, { timeout: 60_000 })

function evidencePath(label: string): string {
  return join(
    tmpdir(),
    `${OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX}${label}-${randomUUID()}`,
  )
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

function material() {
  const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`)
  const candidate = Buffer.from("export default true\n")
  const wrapper = Buffer.from("export { default } from './candidate-entry.js'\n")
  const linker = Buffer.from("export default true\n")
  const dependencyTreeSha256 = "4".repeat(64)
  const graphSha256 = "5".repeat(64)
  const contentTreeSha256 = "e".repeat(64)
  const candidateEntrySha256 = digest(candidate)
  const linkerSha256 = digest(linker)
  const loaderSha256 = digest(wrapper)
  const result = {
    candidateEntrySha256,
    dependencyTreeSha256,
    electronVersion: "42.3.3",
    graphFileCount: 3,
    graphSha256,
    linkedEsmModuleCount: 2,
    nodeVersion: "24.15.0",
    runtimeExecutableSha256: "d".repeat(64),
    runtimeProductVersion: "1.18.21.0",
    schemaVersion: 2,
    suppressedOptionalRootCount: 1,
    type: "opencode-cycle-desktop-module-link",
    verifiedAssetFileCount: 0,
    verifiedCommonJsModuleCount: 1,
    verifiedContentTreeSha256: contentTreeSha256,
    verifiedJsonModuleCount: 0,
  }
  const receipt = {
    candidateEntrySha256,
    dependencyTreeSha256,
    electronVersion: "42.3.3",
    graphFileCount: 3,
    graphSha256,
    linkedEsmModuleCount: 2,
    linkerSha256,
    loaderSha256,
    nativePackageSha256: "a".repeat(64),
    nodeVersion: "24.15.0",
    pluginPackageSha256: "b".repeat(64),
    revision: "c".repeat(40),
    runtimeExecutableSha256: "d".repeat(64),
    runtimeProductVersion: "1.18.21.0",
    schemaVersion: 4,
    suppressedOptionalRootCount: 1,
    type: "opencode-cycle-desktop-runtime-guard",
    verifiedAssetFileCount: 0,
    verifiedCommonJsModuleCount: 1,
    verifiedContentTreeSha256: contentTreeSha256,
    verifiedJsonModuleCount: 0,
  }
  return {
    "candidate-entry.js": candidate,
    "candidate-wrapper.js": wrapper,
    "dependency-tree-manifest.json": json({
      contentTreeSha256,
      dependencyTree: { dependencyTreeSha256 },
      files: [{ path: "dist/index.js", sha256: "f".repeat(64), size: 20 }],
      schemaVersion: 1,
      type: "opencode-cycle-desktop-dependency-tree-manifest",
    }),
    "desktop-runtime-diagnostics.jsonl": json({
      runDigest: "1".repeat(64),
      schemaVersion: 2,
      sequence: 0,
      stage: "certification_env_prepared",
      status: "passed",
      type: "opencode-cycle-desktop-load-diagnostic",
    }),
    "desktop-runtime-linker.mjs": linker,
    "desktop-runtime-result.json": json(result),
    "runtime-output-summary.json": json({
      exitCode: 0,
      outputExceeded: false,
      schemaVersion: 1,
      stderrBytes: 0,
      stderrSha256: "2".repeat(64),
      stdoutBytes: 0,
      stdoutSha256: "2".repeat(64),
      timedOut: false,
      type: "opencode-cycle-official-electron-runtime-output",
    }),
    "runtime-receipt.json": json(receipt),
  } as const
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
