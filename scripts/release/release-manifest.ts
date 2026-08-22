import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { basename, relative, resolve, sep } from "node:path"

import { NATIVE_PACKAGE_NAMES, PRODUCT_IDENTITY } from "../product-identity.js"

export const REQUIRED_CERTIFIED_PLATFORMS = ["linux-x64", "windows-x64"] as const
export const DECLARED_DESKTOP_PLATFORMS = REQUIRED_CERTIFIED_PLATFORMS
export const CERTIFIED_PLATFORMS = DECLARED_DESKTOP_PLATFORMS

export const QUALITY_EVIDENCE_NAMES = ["codebase-500k", "critical-suite"] as const

export type CertifiedPlatform = (typeof DECLARED_DESKTOP_PLATFORMS)[number]
export type CertificationStatus = "certified"
export type QualityEvidenceName = (typeof QUALITY_EVIDENCE_NAMES)[number]

export const DESKTOP_ASSET_NAMES: Readonly<Record<CertifiedPlatform, string>> = {
  "linux-x64": "opencode-desktop-linux-x86_64.AppImage",
  "windows-x64": "opencode-desktop-win-x64.exe",
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
    if (
      evidence.activationMarker !== PRODUCT_IDENTITY.activationMarker ||
      typeof evidence.activationLogSha256 !== "string" ||
      !isRecord(evidence.controlPlane) ||
      evidence.controlPlane.protocolVersion !== 1 ||
      evidence.controlPlane.schemaVersion !== 17 ||
      !isRecord(evidence.desktop) ||
      evidence.desktop.asset !== DESKTOP_ASSET_NAMES[platform] ||
      typeof evidence.desktop.version !== "string" ||
      typeof evidence.desktop.sha256 !== "string" ||
      typeof evidence.nativePackageSha256 !== "string" ||
      typeof evidence.pluginPackageSha256 !== "string"
    ) {
      throw new Error("Desktop certification is incomplete")
    }
    validateDigest(evidence.activationLogSha256)
    validateDigest(evidence.desktop.sha256)
    validateDigest(evidence.nativePackageSha256)
    validateDigest(evidence.pluginPackageSha256)
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
  const artifactsDirectory = resolve(options.artifactsDirectory)
  const artifactPaths = await collectFiles(artifactsDirectory)
  assertDirectUniqueArtifacts(artifactsDirectory, artifactPaths)
  const artifacts = await Promise.all(artifactPaths.map(readArtifact))

  const certificationsDirectory = resolve(options.certificationsDirectory)
  const certificationPaths = await collectFiles(certificationsDirectory)
  const unsupported = certificationPaths.find((path) => !path.endsWith(".json"))
  if (unsupported !== undefined) {
    throw new Error(`Unsupported certification material: ${relative(certificationsDirectory, unsupported)}`)
  }
  const classified = await Promise.all(
    certificationPaths.map(async (path) => {
      const content = await readFile(path)
      const classification = classifyCertificationEvidence(JSON.parse(content.toString("utf8")) as unknown)
      if (classification.revision !== options.revision) {
        throw new Error(`Certification revision does not match: ${basename(path)}`)
      }
      return { evidenceSha256: sha256(content), ...classification }
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
  const value = JSON.parse(await readFile(resolve(path), "utf8")) as unknown
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
  const root = resolve(directory)
  const paths = await collectFiles(root)
  assertDirectUniqueArtifacts(root, paths)
  const artifacts = await Promise.all(paths.map(readArtifact))
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

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await collectFiles(path)))
    else if (entry.isFile()) paths.push(path)
    else throw new Error(`Release material must be a regular file: ${path}`)
  }
  return paths.sort()
}

function assertDirectUniqueArtifacts(root: string, paths: readonly string[]): void {
  const names = new Set<string>()
  for (const path of paths) {
    const name = basename(path)
    if (names.has(name)) throw new Error(`Duplicate artifact: ${name}`)
    names.add(name)
  }
  for (const path of paths) {
    const relativePath = relative(root, path).split(sep).join("/")
    if (relativePath !== basename(path)) throw new Error(`Artifact must be a direct file: ${relativePath}`)
  }
}

async function readArtifact(path: string): Promise<ReleaseArtifact> {
  const content = await readFile(path)
  return { name: basename(path), sha256: sha256(content), size: content.byteLength }
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

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
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
