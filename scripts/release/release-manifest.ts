import { writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"

import { NATIVE_PACKAGE_NAMES, PRODUCT_IDENTITY } from "../product-identity.js"
import { readVerifiedFileDirectory, readVerifiedRegularFile } from "./verified-file.js"

export const REQUIRED_CERTIFIED_PLATFORMS = ["linux-x64", "windows-x64"] as const
export const DECLARED_DESKTOP_PLATFORMS = REQUIRED_CERTIFIED_PLATFORMS
export const CERTIFIED_PLATFORMS = DECLARED_DESKTOP_PLATFORMS

export const QUALITY_EVIDENCE_NAMES = ["codebase-500k", "critical-suite"] as const

export type CertifiedPlatform = (typeof DECLARED_DESKTOP_PLATFORMS)[number]
export type CertificationStatus = "certified"
export type QualityEvidenceName = (typeof QUALITY_EVIDENCE_NAMES)[number]

export const OPENCODE_DESKTOP_VERSION = "1.18.21" as const
export const DESKTOP_ASSET_METADATA = {
  "linux-x64": {
    name: "opencode-desktop-linux-x86_64.AppImage",
    runtimeExecutable: {
      name: "ai.opencode.desktop",
      productVersion: "1.18.21",
      sha256: "008c5cf72df686019c818d2cb0570df8137b49aa5dae64dcf017ea2656c5b7ac",
    },
    sha256: "fb384fc4f030aca8624d775b8757cafa39b5871fc0eddeecebb128f25ed649d8",
    size: 158_944_115,
  },
  "windows-x64": {
    name: "opencode-desktop-win-x64.exe",
    runtimeExecutable: {
      name: "OpenCode.exe",
      productVersion: "1.18.21.0",
      sha256: "c96920bb1d1a4dc5cee64d33c404224e3c37c79111007e3aea861b448e2c4999",
    },
    sha256: "3bd1a81d8fcb377a6bda60a9abf8d412aca1c9c702218ddbbdf7c7b09deaa739",
    size: 126_209_592,
  },
} as const satisfies Readonly<
  Record<CertifiedPlatform, {
    readonly name: string
    readonly runtimeExecutable: {
      readonly name: string
      readonly productVersion: string
      readonly sha256: string
    }
    readonly sha256: string
    readonly size: number
  }>
>
export const DESKTOP_ASSET_NAMES: Readonly<Record<CertifiedPlatform, string>> = {
  "linux-x64": DESKTOP_ASSET_METADATA["linux-x64"].name,
  "windows-x64": DESKTOP_ASSET_METADATA["windows-x64"].name,
}

const NATIVE_PACKAGE_BY_PLATFORM: Readonly<Record<CertifiedPlatform, string>> = {
  "linux-x64": "@opencode-cycle/native-linux-x64",
  "windows-x64": "@opencode-cycle/native-win32-x64",
}

export interface ReleaseArtifact {
  readonly name: string
  readonly sha256: string
  readonly size: number
}

interface ArtifactBinding {
  readonly name: string
  readonly sha256: string
}

export interface ReleaseCertification {
  readonly evidenceSha256: string
  readonly nativeArtifact: ArtifactBinding
  readonly platform: CertifiedPlatform
  readonly pluginArtifact: ArtifactBinding
  readonly revision: string
  readonly status: CertificationStatus
}

export interface ReleaseQualityEvidence {
  readonly evidenceSha256: string
  readonly name: QualityEvidenceName
  readonly revision: string
}

export interface ReleaseManifestInput {
  readonly artifacts: readonly ReleaseArtifact[]
  readonly certifications: readonly ReleaseCertification[]
  readonly qualityEvidence: readonly ReleaseQualityEvidence[]
  readonly revision: string
  readonly version: string
}

export interface ReleaseManifest {
  readonly artifacts: readonly ReleaseArtifact[]
  readonly certifications: readonly ReleaseCertification[]
  readonly product: typeof PRODUCT_IDENTITY.product
  readonly qualityEvidence: readonly ReleaseQualityEvidence[]
  readonly revision: string
  readonly schemaVersion: 1
  readonly version: string
}

type ClassifiedEvidence =
  | {
      readonly kind: "desktop"
      readonly nativePackageSha256: string
      readonly platform: CertifiedPlatform
      readonly pluginPackageSha256: string
      readonly revision: string
    }
  | {
      readonly kind: "quality"
      readonly name: QualityEvidenceName
      readonly revision: string
    }

export function expectedReleaseArtifactNames(version: string): string[] {
  validateVersion(version)
  return [
    archiveName(PRODUCT_IDENTITY.mainPackage, version),
    ...NATIVE_PACKAGE_NAMES.map((name) => archiveName(name, version)),
  ].sort()
}

export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  validateRevision(input.revision)
  validateVersion(input.version)
  validateArtifactRecords(input.artifacts)
  requireExactSet(
    input.artifacts.map((artifact) => artifact.name),
    expectedReleaseArtifactNames(input.version),
    "release artifact",
  )
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.name, artifact]))

  const certificationPlatforms = new Set<CertifiedPlatform>()
  for (const item of input.certifications) {
    if (!(REQUIRED_CERTIFIED_PLATFORMS as readonly string[]).includes(item.platform)) {
      throw new Error(`Unsupported certification platform: ${item.platform}`)
    }
    if (certificationPlatforms.has(item.platform)) {
      throw new Error(`Duplicate certification platform: ${item.platform}`)
    }
    certificationPlatforms.add(item.platform)
    if (item.status !== "certified") throw new Error(`Missing certification evidence: ${item.platform}`)
    validateDigest(item.evidenceSha256)
    validateRevision(item.revision)
    if (item.revision !== input.revision) {
      throw new Error(`Certification revision does not match: ${item.platform}`)
    }
    const expectedPlugin = archiveName(PRODUCT_IDENTITY.mainPackage, input.version)
    const expectedNative = nativeArtifactName(item.platform, input.version)
    validateArtifactBinding(item.pluginArtifact, expectedPlugin, artifacts)
    validateArtifactBinding(item.nativeArtifact, expectedNative, artifacts)
  }
  for (const platform of REQUIRED_CERTIFIED_PLATFORMS) {
    if (!certificationPlatforms.has(platform)) throw new Error(`Missing certification evidence: ${platform}`)
  }

  const qualityNames = new Set<QualityEvidenceName>()
  for (const item of input.qualityEvidence) {
    if (!(QUALITY_EVIDENCE_NAMES as readonly string[]).includes(item.name)) {
      throw new Error(`Unsupported quality evidence: ${item.name}`)
    }
    if (qualityNames.has(item.name)) throw new Error(`Duplicate quality evidence: ${item.name}`)
    qualityNames.add(item.name)
    validateDigest(item.evidenceSha256)
    validateRevision(item.revision)
    if (item.revision !== input.revision) {
      throw new Error(`Quality evidence revision does not match: ${item.name}`)
    }
  }
  for (const name of QUALITY_EVIDENCE_NAMES) {
    if (!qualityNames.has(name)) throw new Error(`Missing quality evidence: ${name}`)
  }

  return {
    artifacts: [...input.artifacts].sort((left, right) => left.name.localeCompare(right.name)),
    certifications: [...input.certifications].sort((left, right) =>
      left.platform.localeCompare(right.platform),
    ),
    product: PRODUCT_IDENTITY.product,
    qualityEvidence: [...input.qualityEvidence].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    revision: input.revision,
    schemaVersion: 1,
    version: input.version,
  }
}

export function classifyCertificationEvidence(evidence: unknown): ClassifiedEvidence {
  if (!isRecord(evidence)) throw new Error("Certification evidence must be an object")
  if (evidence.schemaVersion !== 1) throw new Error("Certification evidence schema is invalid")
  if (typeof evidence.revision !== "string") throw new Error("Certification evidence revision is missing")
  validateRevision(evidence.revision)

  if (typeof evidence.platform === "string") {
    if (!(REQUIRED_CERTIFIED_PLATFORMS as readonly string[]).includes(evidence.platform)) {
      throw new Error("Desktop certification has an invalid platform")
    }
    const platform = evidence.platform as CertifiedPlatform
    requireExactKeys(
      evidence,
      [
        "activationCreatedAtUnixMillis",
        "activationLogSha256",
        "activationMarker",
        "activationNativePackageSha256",
        "activationNonce",
        "activationPluginPackageSha256",
        "activationRevision",
        "activationRunDigest",
        "controlPlane",
        "daemon",
        "desktop",
        "loadDiagnostics",
        "moduleRuntime",
        "nativePackageSha256",
        "platform",
        "pluginPackageSha256",
        "revision",
        "schemaVersion",
      ],
      "Desktop certification",
    )
    const controlPlane = requireExactRecord(
      evidence.controlPlane,
      ["productVersion", "protocolVersion", "schemaMode", "schemaVersion"],
      "Desktop control-plane health",
    )
    const desktop = requireExactRecord(
      evidence.desktop,
      ["asset", "authenticity", "profileIsolation", "sha256", "size", "version"],
      "Desktop asset evidence",
    )
    const daemon = requireExactRecord(
      evidence.daemon,
      [
        "binaryPathSha256",
        "exitMarkerPublished",
        "markerPublished",
        "parentPid",
        "parentStartTimeUnixMillis",
        "pid",
        "processAbsent",
        "processStartTimeUnixMillis",
        "runDigest",
        "shutdownAuthenticated",
        "startedAtUnixMillis",
        "startTokenSha256",
        "terminated",
      ],
      "Desktop daemon evidence",
    )
    const loadDiagnostics = requireExactRecord(
      evidence.loadDiagnostics,
      ["bytes", "sha256"],
      "Desktop load diagnostics evidence",
    )
    const moduleRuntime = requireExactRecord(
      evidence.moduleRuntime,
      [
        "bindingDigest",
        "candidateDefaultExportLinked",
        "candidateEntrySha256",
        "candidateEvaluated",
        "dependencyFileCount",
        "dependencyPackageCount",
        "dependencyTotalBytes",
        "dependencyTreeSha256",
        "electronVersion",
        "fullTreeFileCount",
        "graphFileCount",
        "graphSha256",
        "linkedEsmModuleCount",
        "linkerSha256",
        "loaderSha256",
        "moduleLinked",
        "nativePackageSha256",
        "nodeVersion",
        "pluginPackageSha256",
        "productVersion",
        "revision",
        "runtimeExecutableSha256",
        "runtimeInputContentBytes",
        "runtimeInputFileCount",
        "runtimeInputSerializedBytes",
        "runtimeInputSha256",
        "runtimeProductVersion",
        "schemaVersion",
        "suppressedOptionalRootCount",
        "type",
        "unsafeDynamicImportsRejected",
        "unsafeModuleLoadingRejected",
        "verifiedAssetFileCount",
        "verifiedCommonJsModuleCount",
        "verifiedContentTreeSha256",
        "verifiedJsonModuleCount",
      ],
      "Desktop module runtime evidence",
    )

    const asset = DESKTOP_ASSET_METADATA[platform]
    if (
      evidence.activationMarker !== PRODUCT_IDENTITY.activationMarker ||
      typeof evidence.activationLogSha256 !== "string" ||
      typeof evidence.activationNonce !== "string" ||
      typeof evidence.activationRevision !== "string" ||
      typeof evidence.activationRunDigest !== "string" ||
      typeof evidence.activationPluginPackageSha256 !== "string" ||
      typeof evidence.activationNativePackageSha256 !== "string" ||
      typeof evidence.activationCreatedAtUnixMillis !== "number" ||
      !Number.isSafeInteger(evidence.activationCreatedAtUnixMillis) ||
      evidence.activationCreatedAtUnixMillis < 1 ||
      controlPlane.productVersion !== "1.0.0" ||
      controlPlane.protocolVersion !== 1 ||
      controlPlane.schemaMode !== "read_write" ||
      controlPlane.schemaVersion !== 17 ||
      desktop.asset !== asset.name ||
      desktop.version !== OPENCODE_DESKTOP_VERSION ||
      desktop.sha256 !== asset.sha256 ||
      desktop.size !== asset.size ||
      desktop.profileIsolation !== "fresh-isolated-certification-root" ||
      daemon.exitMarkerPublished !== true ||
      daemon.markerPublished !== true ||
      daemon.processAbsent !== true ||
      daemon.terminated !== true ||
      daemon.shutdownAuthenticated !== true ||
      typeof daemon.parentPid !== "number" ||
      !Number.isSafeInteger(daemon.parentPid) ||
      daemon.parentPid < 1 ||
      typeof daemon.parentStartTimeUnixMillis !== "number" ||
      !Number.isSafeInteger(daemon.parentStartTimeUnixMillis) ||
      daemon.parentStartTimeUnixMillis < 1 ||
      typeof daemon.pid !== "number" ||
      !Number.isSafeInteger(daemon.pid) ||
      daemon.pid < 1 ||
      typeof daemon.processStartTimeUnixMillis !== "number" ||
      !Number.isSafeInteger(daemon.processStartTimeUnixMillis) ||
      daemon.processStartTimeUnixMillis < 1 ||
      daemon.processStartTimeUnixMillis > evidence.activationCreatedAtUnixMillis ||
      typeof daemon.startedAtUnixMillis !== "number" ||
      !Number.isSafeInteger(daemon.startedAtUnixMillis) ||
      daemon.startedAtUnixMillis < 1 ||
      daemon.startedAtUnixMillis > evidence.activationCreatedAtUnixMillis ||
      daemon.startedAtUnixMillis !== daemon.processStartTimeUnixMillis ||
      typeof daemon.binaryPathSha256 !== "string" ||
      typeof daemon.startTokenSha256 !== "string" ||
      typeof daemon.runDigest !== "string" ||
      typeof loadDiagnostics.bytes !== "number" ||
      !Number.isSafeInteger(loadDiagnostics.bytes) ||
      loadDiagnostics.bytes < 1 ||
      loadDiagnostics.bytes > 64 * 1024 ||
      typeof loadDiagnostics.sha256 !== "string" ||
      moduleRuntime.candidateDefaultExportLinked !== true ||
      moduleRuntime.candidateEvaluated !== false ||
      moduleRuntime.unsafeDynamicImportsRejected !== true ||
      moduleRuntime.unsafeModuleLoadingRejected !== true ||
      moduleRuntime.moduleLinked !== true ||
      moduleRuntime.electronVersion !== "42.3.3" ||
      moduleRuntime.nodeVersion !== "24.15.0" ||
      moduleRuntime.productVersion !== OPENCODE_DESKTOP_VERSION ||
      moduleRuntime.runtimeExecutableSha256 !== asset.runtimeExecutable.sha256 ||
      moduleRuntime.runtimeProductVersion !== asset.runtimeExecutable.productVersion ||
      moduleRuntime.schemaVersion !== 5 ||
      moduleRuntime.type !== "opencode-cycle-desktop-runtime-guard" ||
      typeof moduleRuntime.dependencyFileCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.dependencyFileCount) ||
      moduleRuntime.dependencyFileCount < 1 ||
      typeof moduleRuntime.dependencyPackageCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.dependencyPackageCount) ||
      moduleRuntime.dependencyPackageCount < 1 ||
      typeof moduleRuntime.dependencyTotalBytes !== "number" ||
      !Number.isSafeInteger(moduleRuntime.dependencyTotalBytes) ||
      moduleRuntime.dependencyTotalBytes < 1 ||
      typeof moduleRuntime.fullTreeFileCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.fullTreeFileCount) ||
      moduleRuntime.fullTreeFileCount < moduleRuntime.dependencyFileCount ||
      typeof moduleRuntime.runtimeInputFileCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.runtimeInputFileCount) ||
      moduleRuntime.runtimeInputFileCount < 1 ||
      moduleRuntime.runtimeInputFileCount > 10_000 ||
      moduleRuntime.runtimeInputFileCount > moduleRuntime.fullTreeFileCount ||
      typeof moduleRuntime.runtimeInputContentBytes !== "number" ||
      !Number.isSafeInteger(moduleRuntime.runtimeInputContentBytes) ||
      moduleRuntime.runtimeInputContentBytes < 1 ||
      typeof moduleRuntime.runtimeInputSerializedBytes !== "number" ||
      !Number.isSafeInteger(moduleRuntime.runtimeInputSerializedBytes) ||
      moduleRuntime.runtimeInputSerializedBytes < moduleRuntime.runtimeInputContentBytes ||
      moduleRuntime.runtimeInputSerializedBytes > 64 * 1024 * 1024 ||
      typeof moduleRuntime.graphFileCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.graphFileCount) ||
      moduleRuntime.graphFileCount < 1 ||
      moduleRuntime.graphFileCount > moduleRuntime.runtimeInputFileCount ||
      typeof moduleRuntime.linkedEsmModuleCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.linkedEsmModuleCount) ||
      moduleRuntime.linkedEsmModuleCount < 1 ||
      typeof moduleRuntime.verifiedCommonJsModuleCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.verifiedCommonJsModuleCount) ||
      moduleRuntime.verifiedCommonJsModuleCount < 0 ||
      typeof moduleRuntime.verifiedJsonModuleCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.verifiedJsonModuleCount) ||
      moduleRuntime.verifiedJsonModuleCount < 0 ||
      typeof moduleRuntime.verifiedAssetFileCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.verifiedAssetFileCount) ||
      moduleRuntime.verifiedAssetFileCount < 0 ||
      moduleRuntime.linkedEsmModuleCount + moduleRuntime.verifiedCommonJsModuleCount +
        moduleRuntime.verifiedJsonModuleCount + moduleRuntime.verifiedAssetFileCount !==
          moduleRuntime.graphFileCount ||
      typeof moduleRuntime.suppressedOptionalRootCount !== "number" ||
      !Number.isSafeInteger(moduleRuntime.suppressedOptionalRootCount) ||
      moduleRuntime.suppressedOptionalRootCount < 0 ||
      typeof moduleRuntime.bindingDigest !== "string" ||
      typeof moduleRuntime.candidateEntrySha256 !== "string" ||
      typeof moduleRuntime.dependencyTreeSha256 !== "string" ||
      typeof moduleRuntime.graphSha256 !== "string" ||
      typeof moduleRuntime.linkerSha256 !== "string" ||
      typeof moduleRuntime.loaderSha256 !== "string" ||
      typeof moduleRuntime.nativePackageSha256 !== "string" ||
      typeof moduleRuntime.pluginPackageSha256 !== "string" ||
      typeof moduleRuntime.revision !== "string" ||
      typeof moduleRuntime.runtimeExecutableSha256 !== "string" ||
      typeof moduleRuntime.runtimeInputSha256 !== "string" ||
      typeof moduleRuntime.runtimeProductVersion !== "string" ||
      typeof moduleRuntime.verifiedContentTreeSha256 !== "string" ||

      typeof evidence.nativePackageSha256 !== "string" ||
      typeof evidence.pluginPackageSha256 !== "string"
    ) {
      throw new Error("Desktop certification is incomplete")
    }
    validateDigest(evidence.activationLogSha256)
    validateDigest(evidence.activationNonce)
    validateRevision(evidence.activationRevision)
    validateDigest(evidence.activationRunDigest)
    validateDigest(evidence.activationPluginPackageSha256)
    validateDigest(evidence.activationNativePackageSha256)
    validateDigest(evidence.nativePackageSha256)
    validateDigest(evidence.pluginPackageSha256)
    validateDigest(daemon.binaryPathSha256)
    validateDigest(daemon.startTokenSha256)
    validateDigest(daemon.runDigest)
    validateDigest(loadDiagnostics.sha256)
    validateDigest(moduleRuntime.bindingDigest)
    validateDigest(moduleRuntime.candidateEntrySha256)
    validateDigest(moduleRuntime.dependencyTreeSha256)
    validateDigest(moduleRuntime.graphSha256)
    validateDigest(moduleRuntime.linkerSha256)
    validateDigest(moduleRuntime.loaderSha256)
    validateDigest(moduleRuntime.runtimeExecutableSha256)
    validateDigest(moduleRuntime.runtimeInputSha256)
    validateDigest(moduleRuntime.verifiedContentTreeSha256)
    validateRevision(moduleRuntime.revision)

    if (
      evidence.activationRevision !== evidence.revision ||
      evidence.activationPluginPackageSha256 !== evidence.pluginPackageSha256 ||
      evidence.activationNativePackageSha256 !== evidence.nativePackageSha256 ||
      evidence.activationRunDigest !== daemon.runDigest ||
      moduleRuntime.bindingDigest !== evidence.activationRunDigest ||
      moduleRuntime.nativePackageSha256 !== evidence.nativePackageSha256 ||
      moduleRuntime.pluginPackageSha256 !== evidence.pluginPackageSha256 ||
      moduleRuntime.revision !== evidence.revision
    ) {
      throw new Error("Desktop activation binding does not match the receipt")
    }
    validateDesktopAuthenticity(platform, desktop.authenticity)
    return {
      kind: "desktop",
      nativePackageSha256: evidence.nativePackageSha256,
      platform,
      pluginPackageSha256: evidence.pluginPackageSha256,
      revision: evidence.revision,
    }
  }

  if (isRecord(evidence.corpus)) {
    if (
      evidence.passed !== true ||
      !greaterThan500k(evidence.corpus.inventoriedFiles) ||
      !greaterThan500k(evidence.corpus.parsedFiles) ||
      !greaterThan500k(evidence.corpus.physicalFiles) ||
      !positiveInteger(evidence.corpus.sourceFiles) ||
      evidence.corpus.parsedFiles !== evidence.corpus.sourceFiles ||
      !isRecord(evidence.graph) ||
      evidence.graph.parseErrors !== 0 ||
      evidence.graph.oracleRouteFound !== true ||
      !positiveInteger(evidence.graph.queryNodes) ||
      !isRecord(evidence.incremental) ||
      evidence.incremental.modifiedFound !== true ||
      evidence.incremental.renamedFound !== true ||
      evidence.incremental.deletedRemoved !== true ||
      !isRecord(evidence.resources) ||
      !boundedNumber(evidence.resources.peakMemoryPercent, 0, 80) ||
      !isRecord(evidence.timingsMs) ||
      !boundedNumber(evidence.timingsMs.inventoryAndIndex, 0, 1_800_000) ||
      !boundedNumber(evidence.timingsMs.total, 0, 1_800_000)
    ) {
      throw new Error("Codebase certification failed")
    }
    return { kind: "quality", name: "codebase-500k", revision: evidence.revision }
  }

  if ("requestedIterations" in evidence) {
    if (
      evidence.passed !== true ||
      evidence.requestedIterations !== 20 ||
      evidence.completedIterations !== 20 ||
      !Array.isArray(evidence.iterations) ||
      evidence.iterations.length !== 20 ||
      evidence.iterations.some(
        (iteration) =>
          !isRecord(iteration) ||
          typeof iteration.durationMs !== "number" ||
          !Number.isFinite(iteration.durationMs) ||
          iteration.durationMs < 0,
      )
    ) {
      throw new Error("Critical suite certification failed")
    }
    return { kind: "quality", name: "critical-suite", revision: evidence.revision }
  }

  throw new Error("Unsupported certification evidence")
}

export interface CreateReleaseManifestOptions {
  readonly artifactsDirectory: string
  readonly certificationsDirectory: string
  readonly output: string
  readonly revision: string
  readonly version: string
}

export async function createReleaseManifest(options: CreateReleaseManifestOptions): Promise<ReleaseManifest> {
  const artifactFiles = await readVerifiedFileDirectory(options.artifactsDirectory)
  const artifacts = artifactFiles.map(({ name, sha256, size }) => ({ name, sha256, size }))

  const certificationFiles = await readVerifiedFileDirectory(options.certificationsDirectory)
  const unsupported = certificationFiles.find((file) => !file.name.endsWith(".json"))
  if (unsupported !== undefined) {
    throw new Error(`Unsupported certification material: ${unsupported.name}`)
  }
  const classified = await Promise.all(
    certificationFiles.map(async (file) => {
      const classification = classifyCertificationEvidence(JSON.parse(file.content.toString("utf8")) as unknown)
      if (classification.revision !== options.revision) {
        throw new Error(`Certification revision does not match: ${file.name}`)
      }
      return { evidenceSha256: file.sha256, ...classification }
    }),
  )
  const artifactsByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
  const pluginArtifact = requireArtifact(
    artifactsByName,
    archiveName(PRODUCT_IDENTITY.mainPackage, options.version),
  )
  const certifications = classified
    .filter((item) => item.kind === "desktop")
    .map((item) => {
      const nativeArtifact = requireArtifact(
        artifactsByName,
        nativeArtifactName(item.platform, options.version),
      )
      return {
        evidenceSha256: item.evidenceSha256,
        nativeArtifact: { name: nativeArtifact.name, sha256: item.nativePackageSha256 },
        platform: item.platform,
        pluginArtifact: { name: pluginArtifact.name, sha256: item.pluginPackageSha256 },
        revision: item.revision,
        status: "certified" as const,
      }
    })
  const qualityEvidence = classified
    .filter((item) => item.kind === "quality")
    .map((item) => ({
      evidenceSha256: item.evidenceSha256,
      name: item.name,
      revision: item.revision,
    }))
  const manifest = buildReleaseManifest({
    artifacts,
    certifications,
    qualityEvidence,
    revision: options.revision,
    version: options.version,
  })
  await writeFile(resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return manifest
}

export async function readReleaseManifest(path: string): Promise<ReleaseManifest> {
  const file = await readVerifiedRegularFile(path, { maxBytes: 5 * 1024 * 1024 })
  const value = JSON.parse(file.content.toString("utf8")) as unknown
  if (
    !isRecord(value) ||
    value.product !== PRODUCT_IDENTITY.product ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.certifications) ||
    !Array.isArray(value.qualityEvidence) ||
    typeof value.revision !== "string" ||
    typeof value.version !== "string"
  ) {
    throw new Error("Release manifest is malformed")
  }
  return buildReleaseManifest(value as unknown as ReleaseManifestInput)
}

export async function verifyArtifactDirectory(
  directory: string,
  manifestArtifacts: readonly ReleaseArtifact[],
): Promise<ReleaseArtifact[]> {
  const files = await readVerifiedFileDirectory(directory)
  const artifacts = files.map(({ name, sha256, size }) => ({ name, sha256, size }))
  assertArtifactInventoryMatchesManifest(artifacts, manifestArtifacts)
  return artifacts.sort((left, right) => left.name.localeCompare(right.name))
}

export function assertArtifactInventoryMatchesManifest(
  artifacts: readonly ReleaseArtifact[],
  manifestArtifacts: readonly ReleaseArtifact[],
): void {
  validateArtifactRecords(artifacts)
  validateArtifactRecords(manifestArtifacts)
  if (artifacts.length !== manifestArtifacts.length) {
    throw new Error("Artifact inventory does not match the manifest artifact allowlist")
  }
  const actual = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
  for (const expected of manifestArtifacts) {
    const artifact = actual.get(expected.name)
    if (
      artifact === undefined ||
      artifact.sha256 !== expected.sha256 ||
      artifact.size !== expected.size
    ) {
      throw new Error(`Artifact inventory does not match the manifest artifact allowlist: ${expected.name}`)
    }
  }
}

async function main(): Promise<void> {
  await createReleaseManifest(parseArguments(Bun.argv.slice(2)))
}

function archiveName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`
}

function nativeArtifactName(platform: CertifiedPlatform, version: string): string {
  return archiveName(NATIVE_PACKAGE_BY_PLATFORM[platform], version)
}

function requireArtifact(artifacts: ReadonlyMap<string, ReleaseArtifact>, name: string): ReleaseArtifact {
  const artifact = artifacts.get(name)
  if (artifact === undefined) throw new Error(`Release artifact is missing: ${name}`)
  return artifact
}

function validateArtifactBinding(
  binding: ArtifactBinding,
  expectedName: string,
  artifacts: ReadonlyMap<string, ReleaseArtifact>,
): void {
  if (!isRecord(binding) || binding.name !== expectedName || typeof binding.sha256 !== "string") {
    throw new Error(`Certification artifact binding is invalid: ${expectedName}`)
  }
  validateDigest(binding.sha256)
  const artifact = requireArtifact(artifacts, expectedName)
  if (binding.sha256 !== artifact.sha256) {
    throw new Error(`Certification artifact checksum does not match: ${expectedName}`)
  }
}

function validateArtifactRecords(artifacts: readonly ReleaseArtifact[]): void {
  const names = new Set<string>()
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact.name !== "string") {
      throw new Error("Release artifact is malformed")
    }
    if (basename(artifact.name) !== artifact.name) throw new Error("Artifact names must not contain paths")
    if (names.has(artifact.name)) throw new Error(`Duplicate artifact: ${artifact.name}`)
    names.add(artifact.name)
    if (typeof artifact.sha256 !== "string") throw new Error(`Artifact checksum is missing: ${artifact.name}`)
    validateDigest(artifact.sha256)
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) {
      throw new Error(`Artifact size is invalid: ${artifact.name}`)
    }
  }
}

function requireExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const values = new Set(actual)
  if (values.size !== actual.length || values.size !== expected.length) {
    throw new Error(`${label} set is invalid`)
  }
  for (const value of expected) {
    if (!values.has(value)) throw new Error(`Missing ${label}: ${value}`)
  }
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  requireExactKeys(value, keys, label)
  return value
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unknown fields`)
  }
}

function validateDesktopAuthenticity(platform: CertifiedPlatform, value: unknown): void {
  if (platform === "linux-x64") {
    const authenticity = requireExactRecord(value, ["method", "status"], "Desktop authenticity")
    if (authenticity.method !== "sha256" || authenticity.status !== "verified") {
      throw new Error("Linux Desktop authenticity is invalid")
    }
    return
  }
  const authenticity = requireExactRecord(
    value,
    ["applicationSigner", "installerSigner", "method", "status"],
    "Desktop authenticity",
  )
  if (
    authenticity.method !== "authenticode" ||
    authenticity.status !== "verified" ||
    typeof authenticity.applicationSigner !== "string" ||
    authenticity.applicationSigner.trim().length === 0 ||
    typeof authenticity.installerSigner !== "string" ||
    authenticity.installerSigner.trim().length === 0
  ) {
    throw new Error("Windows Desktop authenticity is invalid")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function greaterThan500k(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 500_000
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function boundedNumber(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
}

function parseArguments(argumentsList: readonly string[]): CreateReleaseManifestOptions {
  const options = new Map<string, string>()
  const allowed = new Set([
    "artifacts-directory",
    "certifications-directory",
    "output",
    "revision",
    "version",
  ])
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index]
    const value = argumentsList[index + 1]
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Release manifest arguments must be --key value pairs")
    }
    const name = key.slice(2)
    if (!allowed.has(name) || options.has(name)) throw new Error(`Unknown or duplicate argument: ${key}`)
    options.set(name, value)
  }
  for (const key of allowed) if (!options.has(key)) throw new Error(`Missing --${key}`)
  return {
    artifactsDirectory: options.get("artifacts-directory") as string,
    certificationsDirectory: options.get("certifications-directory") as string,
    output: options.get("output") as string,
    revision: options.get("revision") as string,
    version: options.get("version") as string,
  }
}

function validateDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Invalid SHA-256 digest: ${value}`)
}

function validateRevision(value: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    throw new Error("Release revision must be a full Git object ID")
  }
}

function validateVersion(value: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error("Release version must be semantic")
  }
}

if (import.meta.main) await main()
