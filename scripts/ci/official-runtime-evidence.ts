import { createHash } from "node:crypto"
import type { Dir } from "node:fs"
import { lstat, mkdir, opendir, readdir, realpath, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import {
  assertNoReparseMaterial,
  readVerifiedFileDirectory,
  type VerifiedFile,
} from "../release/verified-file.js"
import { parseDesktopDependencyTreeManifest } from "./desktop-dependency-tree.js"
import { writeReceiptAtomically } from "./receipt-output.js"

export const OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX =
  "opencode-cycle-official-evidence-"

export const OFFICIAL_RUNTIME_MATERIAL_NAMES = [
  "candidate-entry.js",
  "candidate-wrapper.js",
  "dependency-tree-manifest.json",
  "desktop-runtime-diagnostics.jsonl",
  "desktop-runtime-linker.mjs",
  "desktop-runtime-result.json",
  "runtime-output-summary.json",
  "runtime-receipt.json",
] as const

const EVIDENCE_MANIFEST_NAME = "evidence-manifest.json"
const EXIT_RECEIPT_NAME = "package-gate-exit.json"
const GATE_OUTPUT_NAME = "gate-output-summary.json"
const STAGE_FILE = /^stage-(\d{3})-([a-z][a-z0-9-]*)\.json$/u

type OfficialRuntimeMaterialName = typeof OFFICIAL_RUNTIME_MATERIAL_NAMES[number]

const MATERIAL_LIMITS: Readonly<Record<OfficialRuntimeMaterialName, number>> = {
  "candidate-entry.js": 4 * 1024 * 1024,
  "candidate-wrapper.js": 256 * 1024,
  "dependency-tree-manifest.json": 16 * 1024 * 1024,
  "desktop-runtime-diagnostics.jsonl": 64 * 1024,
  "desktop-runtime-linker.mjs": 2 * 1024 * 1024,
  "desktop-runtime-result.json": 64 * 1024,
  "runtime-output-summary.json": 64 * 1024,
  "runtime-receipt.json": 64 * 1024,
}

export interface OfficialRuntimeEvidenceBinding {
  readonly electronVersion: string
  readonly nativePackageSha256: string
  readonly nodeVersion: string
  readonly pluginPackageSha256: string
  readonly revision: string
  readonly runtimeExecutableSha256: string
  readonly runtimeProductVersion: string
}

export interface OfficialGateOutputSummary {
  readonly stderrBytes: number
  readonly stderrSha256: string
  readonly stderrTruncated: boolean
  readonly stdoutBytes: number
  readonly stdoutSha256: string
  readonly stdoutTruncated: boolean
}

export interface OfficialRuntimeEvidencePublication {
  readonly evidenceManifestSha256: string
  readonly exitReceiptSha256: string
  readonly path: string
  readonly passed: boolean
}

export interface OfficialRuntimeEvidenceSession {
  readonly finalizeFailure: (input: {
    readonly errorClass: string
    readonly errorDigest: string
    readonly gateOutput: OfficialGateOutputSummary
    readonly revision?: string
  }) => Promise<OfficialRuntimeEvidencePublication>
  readonly path: string
  readonly publish: (input: {
    readonly binding: OfficialRuntimeEvidenceBinding
    readonly gateOutput: OfficialGateOutputSummary
    readonly material: Readonly<Record<OfficialRuntimeMaterialName, Uint8Array>>
  }) => Promise<OfficialRuntimeEvidencePublication>
  readonly recordStage: (
    stage: string,
    details?: Readonly<Record<string, boolean | number | string | null>>,
  ) => Promise<void>
}

export async function openOfficialRuntimeEvidenceDirectory(
  requestedPath: string,
): Promise<OfficialRuntimeEvidenceSession> {
  const allowedRoot = resolve(tmpdir())
  const target = resolve(requestedPath)
  if (
    !isAbsolute(requestedPath) || requestedPath !== target || requestedPath.includes("\0") ||
    dirname(target) !== allowedRoot ||
    !basename(target).startsWith(OFFICIAL_RUNTIME_EVIDENCE_DIRECTORY_PREFIX)
  ) throw new Error("Official Electron evidence directory is outside its task-owned temp boundary")
  await assertRealDirectory(allowedRoot)
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing !== undefined) throw new Error("Official Electron evidence directory already exists")
  await mkdir(target, { mode: 0o700, recursive: false })
  await assertRealDirectory(target)
  if ((await readdir(target)).length !== 0) {
    throw new Error("Official Electron evidence directory was not created empty")
  }
  let directoryHandle: Dir | undefined = await opendir(target)
  let finalized: OfficialRuntimeEvidencePublication | undefined
  let lastStage: string | undefined
  let nextStage = 0
  const startedAtUnixMillis = Date.now()
  const closeHandle = async (): Promise<void> => {
    if (directoryHandle === undefined) return
    const handle = directoryHandle
    directoryHandle = undefined
    await handle.close()
  }
  const ensureOpen = (): void => {
    if (directoryHandle === undefined || finalized !== undefined) {
      throw new Error("Official Electron evidence session is closed")
    }
  }
  const writeOutputSummary = async (summary: OfficialGateOutputSummary): Promise<void> => {
    validateGateOutput(summary)
    await writeReceiptAtomically(
      { directory: target, path: join(target, GATE_OUTPUT_NAME) },
      jsonLine({
        ...summary,
        schemaVersion: 2,
        type: "opencode-cycle-official-electron-gate-output",
      }),
    )
  }
  const recordStage: OfficialRuntimeEvidenceSession["recordStage"] = async (stage, details = {}) => {
    ensureOpen()
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(stage)) {
      throw new Error("Official Electron evidence stage is invalid")
    }
    assertNoSensitiveReceiptValue(details)
    const sequence = nextStage
    await writeReceiptAtomically(
      {
        directory: target,
        path: join(target, `stage-${String(sequence).padStart(3, "0")}-${stage}.json`),
      },
      jsonLine({
        atUnixMillis: Date.now(),
        details,
        schemaVersion: 1,
        sequence,
        stage,
        type: "opencode-cycle-official-electron-stage",
      }),
    )
    nextStage += 1
    lastStage = stage
  }
  const writeManifest = async (binding: {
    readonly nativePackageSha256?: string
    readonly pluginPackageSha256?: string
    readonly revision?: string
  }): Promise<VerifiedFile> => {
    const files = await readVerifiedFileDirectory(target)
    const artifacts = files
      .filter((file) => file.name !== EVIDENCE_MANIFEST_NAME && file.name !== EXIT_RECEIPT_NAME)
      .map((file) => ({ bytes: file.size, name: file.name, sha256: file.sha256 }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return writeReceiptAtomically(
      { directory: target, path: join(target, EVIDENCE_MANIFEST_NAME) },
      jsonLine({
        artifacts,
        nativePackageSha256: binding.nativePackageSha256 ?? null,
        pluginPackageSha256: binding.pluginPackageSha256 ?? null,
        revision: binding.revision ?? null,
        schemaVersion: 2,
        type: "opencode-cycle-official-electron-evidence-manifest",
      }),
    )
  }
  const finish = async (
    exitValue: Record<string, unknown>,
    manifest: VerifiedFile,
    passed: boolean,
  ): Promise<OfficialRuntimeEvidencePublication> => {
    const exit = await writeReceiptAtomically(
      { directory: target, path: join(target, EXIT_RECEIPT_NAME) },
      jsonLine({
        ...exitValue,
        durationMillis: Date.now() - startedAtUnixMillis,
        evidenceManifestSha256: manifest.sha256,
        passed,
        schemaVersion: 2,
        type: "opencode-cycle-official-electron-package-gate-exit",
      }),
    )
    try {
      await validateOfficialRuntimeEvidenceDirectory(target)
    } catch (error) {
      const cleanupFailures: unknown[] = []
      for (const path of [join(target, EXIT_RECEIPT_NAME), join(target, EVIDENCE_MANIFEST_NAME)]) {
        try {
          await unlink(path)
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Official Electron final evidence validation cleanup failed",
        )
      }
      throw error
    }
    await closeHandle()
    finalized = {
      evidenceManifestSha256: manifest.sha256,
      exitReceiptSha256: exit.sha256,
      passed,
      path: target,
    }
    return finalized
  }
  const finalizeFailure: OfficialRuntimeEvidenceSession["finalizeFailure"] = async (input) => {
    if (finalized !== undefined) return finalized
    ensureOpen()
    validateFailure(input)
    if (lastStage !== "gate-failed") {
      await recordStage("gate-failed", { errorClass: input.errorClass })
    }
    const outputExists = await lstat(join(target, GATE_OUTPUT_NAME)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (!outputExists) await writeOutputSummary(input.gateOutput)
    const manifest = await writeManifest({ revision: input.revision })
    return finish({
      errorClass: input.errorClass,
      errorDigest: input.errorDigest,
      revision: input.revision ?? null,
      status: "failed",
    }, manifest, false)
  }
  return {
    finalizeFailure,
    path: target,
    async publish(input) {
      if (finalized !== undefined) return finalized
      ensureOpen()
      try {
        if (lastStage !== "evidence-publishing") await recordStage("evidence-publishing")
        validateBinding(input.binding)
        validateGateOutput(input.gateOutput)
        validateMaterial(input.material)
        for (const name of OFFICIAL_RUNTIME_MATERIAL_NAMES) {
          await writeReceiptAtomically(
            { directory: target, path: join(target, name) },
            input.material[name],
          )
        }
        await writeOutputSummary(input.gateOutput)
        const manifest = await writeManifest(input.binding)
        return await finish({
          electronVersion: input.binding.electronVersion,
          nativePackageSha256: input.binding.nativePackageSha256,
          nodeVersion: input.binding.nodeVersion,
          pluginPackageSha256: input.binding.pluginPackageSha256,
          revision: input.binding.revision,
          runtimeExecutableSha256: input.binding.runtimeExecutableSha256,
          runtimeProductVersion: input.binding.runtimeProductVersion,
          status: "passed",
        }, manifest, true)
      } catch (error) {
        return finalizeFailure({
          errorClass: "evidence_publication",
          errorDigest: digestError(error),
          gateOutput: input.gateOutput,
          revision: input.binding.revision,
        })
      }
    },
    recordStage,
  }
}

export async function validateOfficialRuntimeEvidenceDirectory(path: string): Promise<void> {
  const files = await readVerifiedFileDirectory(path)
  const byName = new Map(files.map((file) => [file.name, file]))
  const manifest = assertJsonArtifact(
    byName,
    EVIDENCE_MANIFEST_NAME,
    2,
    "opencode-cycle-official-electron-evidence-manifest",
  )
  const exit = assertJsonArtifact(
    byName,
    EXIT_RECEIPT_NAME,
    2,
    "opencode-cycle-official-electron-package-gate-exit",
  )
  const output = assertJsonArtifact(
    byName,
    GATE_OUTPUT_NAME,
    2,
    "opencode-cycle-official-electron-gate-output",
  )
  validateGateOutputRecord(output)
  const stages = files
    .filter((file) => STAGE_FILE.test(file.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (stages.length < 1) throw new Error("Official Electron evidence has no progress stages")
  const stageValues: Record<string, unknown>[] = []
  for (const [sequence, file] of stages.entries()) {
    const match = STAGE_FILE.exec(file.name)
    const value = assertJsonArtifact(
      byName,
      file.name,
      1,
      "opencode-cycle-official-electron-stage",
    )
    if (
      match === null || Number(match[1]) !== sequence || value.sequence !== sequence ||
      value.stage !== match[2] || typeof value.atUnixMillis !== "number"
    ) throw new Error("Official Electron evidence stage sequence is invalid")
    stageValues.push(value)
  }
  if (stageValues[0]?.stage !== "gate-started") {
    throw new Error("Official Electron evidence does not start at the outer gate boundary")
  }
  const allowedNames = new Set([
    ...OFFICIAL_RUNTIME_MATERIAL_NAMES,
    GATE_OUTPUT_NAME,
    EVIDENCE_MANIFEST_NAME,
    EXIT_RECEIPT_NAME,
  ])
  const unexpected = files.find((file) => !allowedNames.has(file.name as OfficialRuntimeMaterialName) &&
    !STAGE_FILE.test(file.name))
  if (unexpected !== undefined) {
    throw new Error("Official Electron evidence filenames are not the exact current schema")
  }
  const artifactRecords = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  const manifestedFiles = files
    .filter((file) => file.name !== EVIDENCE_MANIFEST_NAME && file.name !== EXIT_RECEIPT_NAME)
  if (artifactRecords.length !== manifestedFiles.length) {
    throw new Error("Official Electron evidence manifest is incomplete")
  }
  for (const file of manifestedFiles) {
    const record = artifactRecords.find((value) => isRecord(value) && value.name === file.name)
    if (!isRecord(record) || record.bytes !== file.size || record.sha256 !== file.sha256) {
      throw new Error("Official Electron evidence manifest digest is invalid")
    }
  }
  const manifestFile = byName.get(EVIDENCE_MANIFEST_NAME)
  if (
    manifestFile === undefined || exit.evidenceManifestSha256 !== manifestFile.sha256 ||
    typeof exit.passed !== "boolean" || !["failed", "passed"].includes(String(exit.status)) ||
    typeof exit.durationMillis !== "number" || !Number.isSafeInteger(exit.durationMillis) ||
    exit.durationMillis < 0
  ) throw new Error("Official Electron package-gate exit receipt is invalid")
  if (exit.passed === true) {
    if (
      stageValues.at(-1)?.stage !== "evidence-publishing" ||
      !stageValues.some((stage) => stage.stage === "runtime-started") ||
      !stageValues.some((stage) => stage.stage === "runtime-completed")
    ) throw new Error("Official Electron success evidence stages are incomplete")
    validateRuntimeStages(stageValues, "none")
    validateEvidenceMaterialStage(stageValues, byName.get("dependency-tree-manifest.json"))
    validateSuccessfulEvidence(byName, manifest, exit)
  } else {
    const finalStage = stageValues.at(-1)
    if (
      finalStage?.stage !== "gate-failed" || !isRecord(finalStage.details) ||
      finalStage.details.errorClass !== exit.errorClass
    ) throw new Error("Official Electron failure evidence stages are incomplete")
    if (stageValues.some((stage) => stage.stage === "runtime-guard-passed")) {
      validateRuntimeStages(stageValues, "none")
    } else if (["output_limit", "runtime_exit", "timeout"].includes(String(exit.errorClass))) {
      validateRuntimeStages(stageValues, String(exit.errorClass))
    }
    validateFailedEvidence(exit)
  }
  for (const value of [manifest, exit, output]) assertNoSensitiveReceiptValue(value)
}

function validateEvidenceMaterialStage(
  stages: readonly Record<string, unknown>[],
  manifest: VerifiedFile | undefined,
): void {
  const prepared = stages.find((stage) => stage.stage === "evidence-material-prepared")
  const details = isRecord(prepared?.details) ? prepared.details : undefined
  if (
    details === undefined || typeof details.dependencyManifestBytes !== "number" ||
    !Number.isSafeInteger(details.dependencyManifestBytes) ||
    details.dependencyManifestBytes < 1 || details.dependencyManifestBytes > 16 * 1024 * 1024 ||
    typeof details.dependencyManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(details.dependencyManifestSha256) || manifest === undefined ||
    details.dependencyManifestBytes !== manifest.size ||
    details.dependencyManifestSha256 !== manifest.sha256
  ) throw new Error("Official Electron evidence material stage is invalid")
}

function validateRuntimeStages(
  stages: readonly Record<string, unknown>[],
  expectedErrorClass: string,
): void {
  const prepared = stages.find((stage) => stage.stage === "module-graph-prepared")
  const started = stages.find((stage) => stage.stage === "runtime-started")
  const completed = stages.find((stage) => stage.stage === "runtime-completed")
  const preparedDetails = isRecord(prepared?.details) ? prepared.details : undefined
  const startedDetails = isRecord(started?.details) ? started.details : undefined
  const completedDetails = isRecord(completed?.details) ? completed.details : undefined
  if (
    preparedDetails === undefined || startedDetails === undefined || completedDetails === undefined ||
    typeof preparedDetails.fullTreeFileCount !== "number" ||
    !Number.isSafeInteger(preparedDetails.fullTreeFileCount) || preparedDetails.fullTreeFileCount < 1 ||
    typeof preparedDetails.fullTreeSerializedBytes !== "number" ||
    !Number.isSafeInteger(preparedDetails.fullTreeSerializedBytes) ||
    preparedDetails.fullTreeSerializedBytes < 1 ||
    preparedDetails.fullTreeSerializedBytes > 512 * 1024 * 1024 ||
    typeof preparedDetails.inputPreparationDurationMillis !== "number" ||
    !Number.isSafeInteger(preparedDetails.inputPreparationDurationMillis) ||
    preparedDetails.inputPreparationDurationMillis < 0 ||
    typeof preparedDetails.runtimeInputContentBytes !== "number" ||
    !Number.isSafeInteger(preparedDetails.runtimeInputContentBytes) ||
    preparedDetails.runtimeInputContentBytes < 1 ||
    typeof preparedDetails.runtimeInputFileCount !== "number" ||
    !Number.isSafeInteger(preparedDetails.runtimeInputFileCount) ||
    preparedDetails.runtimeInputFileCount < 1 ||
    preparedDetails.runtimeInputFileCount > 10_000 ||
    preparedDetails.runtimeInputFileCount > preparedDetails.fullTreeFileCount ||
    typeof preparedDetails.runtimeInputSerializedBytes !== "number" ||
    !Number.isSafeInteger(preparedDetails.runtimeInputSerializedBytes) ||
    preparedDetails.runtimeInputSerializedBytes < preparedDetails.runtimeInputContentBytes ||
    preparedDetails.runtimeInputSerializedBytes > 64 * 1024 * 1024 ||
    typeof preparedDetails.runtimeInputSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(preparedDetails.runtimeInputSha256) ||
    typeof startedDetails.runtimePid !== "number" ||
    !Number.isSafeInteger(startedDetails.runtimePid) || startedDetails.runtimePid < 1 ||
    typeof startedDetails.timeoutMillis !== "number" ||
    !Number.isSafeInteger(startedDetails.timeoutMillis) || startedDetails.timeoutMillis < 10 ||
    typeof completedDetails.durationMillis !== "number" ||
    !Number.isSafeInteger(completedDetails.durationMillis) || completedDetails.durationMillis < 0 ||
    typeof completedDetails.exitCode !== "number" ||
    !Number.isSafeInteger(completedDetails.exitCode) ||
    typeof completedDetails.outputExceeded !== "boolean" ||
    typeof completedDetails.timedOut !== "boolean" ||
    typeof completedDetails.stderrBytes !== "number" ||
    !Number.isSafeInteger(completedDetails.stderrBytes) || completedDetails.stderrBytes < 0 ||
    typeof completedDetails.stdoutBytes !== "number" ||
    !Number.isSafeInteger(completedDetails.stdoutBytes) || completedDetails.stdoutBytes < 0 ||
    typeof completedDetails.stderrSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(completedDetails.stderrSha256) ||
    typeof completedDetails.stdoutSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(completedDetails.stdoutSha256) ||
    !["none", "output_limit", "runtime_exit", "timeout"].includes(String(completedDetails.errorClass)) ||
    completedDetails.errorClass !== expectedErrorClass
  ) throw new Error("Official Electron runtime progress stages are invalid")
}

function validateSuccessfulEvidence(
  byName: ReadonlyMap<string, VerifiedFile>,
  manifest: Record<string, unknown>,
  exit: Record<string, unknown>,
): void {
  for (const name of OFFICIAL_RUNTIME_MATERIAL_NAMES) {
    if (!byName.has(name)) throw new Error("Official Electron success evidence is incomplete")
  }
  const treeFile = byName.get("dependency-tree-manifest.json")
  if (treeFile === undefined) throw new Error("Official Electron dependency tree evidence is missing")
  const tree = parseDesktopDependencyTreeManifest(treeFile.content)
  assertJsonLines(byName.get("desktop-runtime-diagnostics.jsonl"))
  const result = assertJsonArtifact(byName, "desktop-runtime-result.json", 3,
    "opencode-cycle-desktop-module-link")
  const runtimeOutput = assertJsonArtifact(byName, "runtime-output-summary.json", 1,
    "opencode-cycle-official-electron-runtime-output")
  const runtime = assertJsonArtifact(byName, "runtime-receipt.json", 5,
    "opencode-cycle-desktop-runtime-guard")
  const candidate = byName.get("candidate-entry.js")
  const linker = byName.get("desktop-runtime-linker.mjs")
  const loader = byName.get("candidate-wrapper.js")
  const dependencyTree = isRecord(tree.dependencyTree) ? tree.dependencyTree : undefined
  if (
    candidate === undefined || linker === undefined || loader === undefined ||
    !isRecord(dependencyTree) ||
    runtime.candidateEntrySha256 !== candidate.sha256 ||
    runtime.linkerSha256 !== linker.sha256 ||
    runtime.loaderSha256 !== loader.sha256 ||
    runtime.dependencyTreeSha256 !== dependencyTree.dependencyTreeSha256 ||
    runtime.verifiedContentTreeSha256 !== tree.contentTreeSha256 ||
    !Array.isArray(tree.files) || typeof runtime.fullTreeFileCount !== "number" ||
    runtime.fullTreeFileCount !== tree.files.length ||
    result.fullTreeFileCount !== runtime.fullTreeFileCount ||
    result.runtimeInputContentBytes !== runtime.runtimeInputContentBytes ||
    result.runtimeInputFileCount !== runtime.runtimeInputFileCount ||
    result.runtimeInputSerializedBytes !== runtime.runtimeInputSerializedBytes ||
    result.runtimeInputSha256 !== runtime.runtimeInputSha256 ||
    result.candidateEntrySha256 !== runtime.candidateEntrySha256 ||
    result.dependencyTreeSha256 !== runtime.dependencyTreeSha256 ||
    result.graphFileCount !== runtime.graphFileCount ||
    result.graphSha256 !== runtime.graphSha256 ||
    result.linkedEsmModuleCount !== runtime.linkedEsmModuleCount ||
    result.verifiedCommonJsModuleCount !== runtime.verifiedCommonJsModuleCount ||
    result.verifiedJsonModuleCount !== runtime.verifiedJsonModuleCount ||
    result.verifiedAssetFileCount !== runtime.verifiedAssetFileCount ||
    typeof runtime.graphFileCount !== "number" ||
    typeof runtime.runtimeInputContentBytes !== "number" ||
    typeof runtime.runtimeInputFileCount !== "number" ||
    runtime.runtimeInputFileCount < runtime.graphFileCount ||
    runtime.runtimeInputFileCount > runtime.fullTreeFileCount ||
    typeof runtime.runtimeInputSerializedBytes !== "number" ||
    runtime.runtimeInputSerializedBytes < runtime.runtimeInputContentBytes ||
    typeof runtime.runtimeInputSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(runtime.runtimeInputSha256) ||
    result.verifiedContentTreeSha256 !== runtime.verifiedContentTreeSha256 ||
    result.suppressedOptionalRootCount !== runtime.suppressedOptionalRootCount ||
    result.electronVersion !== runtime.electronVersion ||
    result.nodeVersion !== runtime.nodeVersion ||
    result.runtimeExecutableSha256 !== runtime.runtimeExecutableSha256 ||
    result.runtimeProductVersion !== runtime.runtimeProductVersion ||
    manifest.nativePackageSha256 !== runtime.nativePackageSha256 ||
    manifest.pluginPackageSha256 !== runtime.pluginPackageSha256 ||
    manifest.revision !== runtime.revision ||
    exit.nativePackageSha256 !== runtime.nativePackageSha256 ||
    exit.pluginPackageSha256 !== runtime.pluginPackageSha256 ||
    exit.revision !== runtime.revision ||
    exit.electronVersion !== runtime.electronVersion ||
    exit.nodeVersion !== runtime.nodeVersion ||
    exit.runtimeExecutableSha256 !== runtime.runtimeExecutableSha256 ||
    exit.runtimeProductVersion !== runtime.runtimeProductVersion ||
    runtimeOutput.exitCode !== 0 || runtimeOutput.outputExceeded !== false ||
    runtimeOutput.timedOut !== false || runtimeOutput.stderrBytes !== 0 ||
    runtimeOutput.stdoutBytes !== 0 ||
    exit.status !== "passed"
  ) throw new Error("Official Electron evidence cross-binding is invalid")
}

function validateFailedEvidence(exit: Record<string, unknown>): void {
  if (
    exit.status !== "failed" || typeof exit.errorClass !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(exit.errorClass) ||
    typeof exit.errorDigest !== "string" || !/^[0-9a-f]{64}$/u.test(exit.errorDigest)
  ) throw new Error("Official Electron failure evidence is invalid")
}

function validateMaterial(
  material: Readonly<Record<OfficialRuntimeMaterialName, Uint8Array>>,
): void {
  const keys = Object.keys(material).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...OFFICIAL_RUNTIME_MATERIAL_NAMES].sort())) {
    throw new Error("Official Electron evidence material set is incomplete")
  }
  for (const name of OFFICIAL_RUNTIME_MATERIAL_NAMES) {
    const content = material[name]
    if (!(content instanceof Uint8Array) || content.byteLength < 1 ||
      content.byteLength > MATERIAL_LIMITS[name]) {
      throw new Error(`Official Electron evidence material is outside its bound: ${name}`)
    }
  }
}

function validateBinding(binding: OfficialRuntimeEvidenceBinding): void {
  for (const digest of [
    binding.nativePackageSha256,
    binding.pluginPackageSha256,
    binding.runtimeExecutableSha256,
  ]) {
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("Official Electron evidence binding digest is invalid")
    }
  }
  if (
    !/^[0-9a-f]{40}$/u.test(binding.revision) ||
    !/^\d+\.\d+\.\d+$/u.test(binding.electronVersion) ||
    !/^\d+\.\d+\.\d+$/u.test(binding.nodeVersion) ||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(binding.runtimeProductVersion)
  ) throw new Error("Official Electron evidence runtime binding is invalid")
}

function validateGateOutput(summary: OfficialGateOutputSummary): void {
  for (const bytes of [summary.stderrBytes, summary.stdoutBytes]) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 16 * 1024 * 1024) {
      throw new Error("Official Electron gate output byte count is invalid")
    }
  }
  for (const digest of [summary.stderrSha256, summary.stdoutSha256]) {
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error("Official Electron gate output digest is invalid")
    }
  }
  if (typeof summary.stderrTruncated !== "boolean" || typeof summary.stdoutTruncated !== "boolean") {
    throw new Error("Official Electron gate output truncation state is invalid")
  }
}

function validateGateOutputRecord(value: Record<string, unknown>): void {
  validateGateOutput({
    stderrBytes: Number(value.stderrBytes),
    stderrSha256: String(value.stderrSha256),
    stderrTruncated: value.stderrTruncated === true,
    stdoutBytes: Number(value.stdoutBytes),
    stdoutSha256: String(value.stdoutSha256),
    stdoutTruncated: value.stdoutTruncated === true,
  })
  if (typeof value.stderrTruncated !== "boolean" || typeof value.stdoutTruncated !== "boolean") {
    throw new Error("Official Electron gate output truncation state is invalid")
  }
}

function validateFailure(input: {
  readonly errorClass: string
  readonly errorDigest: string
  readonly gateOutput: OfficialGateOutputSummary
  readonly revision?: string
}): void {
  validateGateOutput(input.gateOutput)
  if (
    !/^[a-z][a-z0-9_]{0,63}$/u.test(input.errorClass) ||
    !/^[0-9a-f]{64}$/u.test(input.errorDigest) ||
    (input.revision !== undefined && !/^[0-9a-f]{40}$/u.test(input.revision))
  ) throw new Error("Official Electron failure binding is invalid")
}

function assertJsonArtifact(
  files: ReadonlyMap<string, VerifiedFile>,
  name: string,
  schemaVersion: number,
  type: string,
): Record<string, unknown> {
  const file = files.get(name)
  if (file === undefined) throw new Error(`Official Electron evidence is missing ${name}`)
  let value: unknown
  try {
    value = JSON.parse(file.content.toString("utf8")) as unknown
  } catch {
    throw new Error(`Official Electron evidence JSON is malformed: ${name}`)
  }
  if (!isRecord(value) || value.schemaVersion !== schemaVersion || value.type !== type) {
    throw new Error(`Official Electron evidence schema is invalid: ${name}`)
  }
  assertNoSensitiveReceiptValue(value)
  return value
}

function assertJsonLines(file: VerifiedFile | undefined): void {
  if (file === undefined) throw new Error("Official Electron runtime diagnostics are missing")
  const lines = file.content.toString("utf8").trim().split("\n")
  if (lines.length < 1) throw new Error("Official Electron runtime diagnostics are empty")
  for (const line of lines) {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      throw new Error("Official Electron runtime diagnostics are malformed")
    }
    if (!isRecord(value) || value.schemaVersion !== 2) {
      throw new Error("Official Electron runtime diagnostic schema is invalid")
    }
    assertNoSensitiveReceiptValue(value)
  }
}

function assertNoSensitiveReceiptValue(value: unknown, key = ""): void {
  if (/nonce|secret|token/iu.test(key)) {
    throw new Error("Official Electron receipt contains a secret-bearing field")
  }
  if (typeof value === "string") {
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("file:")) {
      throw new Error("Official Electron receipt contains a local path")
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveReceiptValue(item)
    return
  }
  if (isRecord(value)) {
    for (const [childKey, item] of Object.entries(value)) {
      assertNoSensitiveReceiptValue(item, childKey)
    }
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error("Official Electron evidence directory is a link, reparse point or alias")
  }
  await assertNoReparseMaterial([path])
}

export function digestOfficialEvidenceError(error: unknown): string {
  return digestError(error)
}

function digestError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}\0${error.message}` : String(error)
  return createHash("sha256").update(message).digest("hex")
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
