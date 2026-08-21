import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import { PRODUCT_IDENTITY } from "../product-identity.js"

export const REQUIRED_CERTIFIED_PLATFORMS = ["linux-x64", "windows-x64"] as const
export const DECLARED_DESKTOP_PLATFORMS = REQUIRED_CERTIFIED_PLATFORMS
export const CERTIFIED_PLATFORMS = DECLARED_DESKTOP_PLATFORMS

export const QUALITY_EVIDENCE_NAMES = ["codebase-500k", "critical-suite"] as const

export type CertifiedPlatform = (typeof DECLARED_DESKTOP_PLATFORMS)[number]
export type CertificationStatus = "certified"
export type QualityEvidenceName = (typeof QUALITY_EVIDENCE_NAMES)[number]

export interface ReleaseCertification {
  readonly evidenceSha256?: string
  readonly platform: CertifiedPlatform
  readonly status: CertificationStatus
}

export interface ReleaseManifestInput {
  readonly artifacts: readonly { readonly name: string; readonly sha256: string; readonly size: number }[]
  readonly certifications: readonly ReleaseCertification[]
  readonly qualityEvidence: readonly {
    readonly evidenceSha256: string
    readonly name: QualityEvidenceName
  }[]
  readonly revision: string
  readonly version: string
}

export interface ReleaseManifest {
  readonly artifacts: ReleaseManifestInput["artifacts"]
  readonly certifications: readonly ReleaseCertification[]
  readonly product: typeof PRODUCT_IDENTITY.product
  readonly qualityEvidence: ReleaseManifestInput["qualityEvidence"]
  readonly revision: string
  readonly schemaVersion: 1
  readonly version: string
}

export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.revision)) {
    throw new Error("Release revision must be a full Git object ID")
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.version)) {
    throw new Error("Release version must be semantic")
  }
  const artifactNames = new Set<string>()
  for (const artifact of input.artifacts) {
    if (basename(artifact.name) !== artifact.name) throw new Error("Artifact names must not contain paths")
    if (artifactNames.has(artifact.name)) throw new Error(`Duplicate artifact: ${artifact.name}`)
    artifactNames.add(artifact.name)
    validateDigest(artifact.sha256)
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) {
      throw new Error(`Artifact size is invalid: ${artifact.name}`)
    }
  }
  const certificationPlatforms = new Set<CertifiedPlatform>()
  for (const item of input.certifications) {
    if (certificationPlatforms.has(item.platform)) {
      throw new Error(`Duplicate certification platform: ${item.platform}`)
    }
    certificationPlatforms.add(item.platform)
    if ((REQUIRED_CERTIFIED_PLATFORMS as readonly string[]).includes(item.platform)) {
      if (item.status !== "certified" || item.evidenceSha256 === undefined) {
        throw new Error(`Missing certification evidence: ${item.platform}`)
      }
      validateDigest(item.evidenceSha256)
    } else {
      throw new Error(`Unsupported certification platform: ${item.platform}`)
    }
  }
  for (const platform of DECLARED_DESKTOP_PLATFORMS) {
    if (!certificationPlatforms.has(platform)) throw new Error(`Missing certification evidence: ${platform}`)
  }
  const qualityNames = new Set(input.qualityEvidence.map((item) => item.name))
  for (const name of QUALITY_EVIDENCE_NAMES) {
    if (!qualityNames.has(name)) throw new Error(`Missing quality evidence: ${name}`)
  }
  if (qualityNames.size !== QUALITY_EVIDENCE_NAMES.length) {
    throw new Error("Quality evidence contains an unsupported or duplicate result")
  }
  input.qualityEvidence.forEach((item) => validateDigest(item.evidenceSha256))

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

export function classifyCertificationEvidence(
  evidence: unknown,
):
  | { readonly kind: "desktop"; readonly platform: CertifiedPlatform }
  | { readonly kind: "quality"; readonly name: QualityEvidenceName } {
  if (!isRecord(evidence)) throw new Error("Certification evidence must be an object")
  if (typeof evidence.platform === "string") {
    if (!(REQUIRED_CERTIFIED_PLATFORMS as readonly string[]).includes(evidence.platform)) {
      throw new Error("Desktop certification has an invalid platform")
    }
    if (
      evidence.activationMarker !== PRODUCT_IDENTITY.activationMarker ||
      !isRecord(evidence.controlPlane) ||
      evidence.controlPlane.protocolVersion !== 1 ||
      evidence.controlPlane.schemaVersion !== 17
    ) {
      throw new Error("Desktop certification is incomplete")
    }
    return { kind: "desktop", platform: evidence.platform as CertifiedPlatform }
  }
  if (isRecord(evidence.corpus)) {
    if (evidence.passed !== true) throw new Error("Codebase certification failed")
    if (
      !greaterThan500k(evidence.corpus.inventoriedFiles) ||
      !greaterThan500k(evidence.corpus.parsedFiles) ||
      !greaterThan500k(evidence.corpus.physicalFiles)
    ) {
      throw new Error("Codebase certification does not exceed 500,000 files")
    }
    return { kind: "quality", name: "codebase-500k" }
  }
  if ("requestedIterations" in evidence) {
    if (
      evidence.passed !== true ||
      evidence.requestedIterations !== 20 ||
      evidence.completedIterations !== 20
    ) {
      throw new Error("Critical suite certification failed")
    }
    return { kind: "quality", name: "critical-suite" }
  }
  throw new Error("Unsupported certification evidence")
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2))
  const artifactPaths = await files(resolve(options.artifactsDirectory))
  const certificationPaths = (await files(resolve(options.certificationsDirectory))).filter((path) =>
    path.endsWith(".json"),
  )
  const artifacts = await Promise.all(
    artifactPaths.map(async (path) => {
      const content = await readFile(path)
      return { name: basename(path), sha256: sha256(content), size: content.byteLength }
    }),
  )
  const classified = await Promise.all(
    certificationPaths.map(async (path) => {
      const content = await readFile(path)
      const evidence = JSON.parse(content.toString("utf8")) as unknown
      const classification = classifyCertificationEvidence(evidence)
      if (
        classification.kind === "desktop" &&
        (!isRecord(evidence) || evidence.revision !== options.revision)
      ) {
        throw new Error(`Certification revision does not match: ${basename(path)}`)
      }
      return {
        evidenceSha256: sha256(content),
        ...classification,
      }
    }),
  )
  const certified = classified
    .filter((item) => item.kind === "desktop")
    .map(({ evidenceSha256, platform }) => ({
      evidenceSha256,
      platform,
      status: "certified" as const,
    }))
  const certifications = certified
  const qualityEvidence = classified
    .filter((item) => item.kind === "quality")
    .map(({ evidenceSha256, name }) => ({ evidenceSha256, name }))
  const manifest = buildReleaseManifest({
    artifacts,
    certifications,
    qualityEvidence,
    revision: options.revision,
    version: options.version,
  })
  await writeFile(resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory()
        ? files(path)
        : Promise.resolve(entry.name.endsWith(".sha256") ? [] : [path])
    }),
  )
  return paths.flat().sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function greaterThan500k(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 500_000
}

function parseArguments(argumentsList: readonly string[]): {
  artifactsDirectory: string
  certificationsDirectory: string
  output: string
  revision: string
  version: string
} {
  const options = new Map<string, string>()
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index]
    const value = argumentsList[index + 1]
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Release manifest arguments must be --key value pairs")
    }
    options.set(key.slice(2), value)
  }
  const required = ["artifacts-directory", "certifications-directory", "output", "revision", "version"]
  for (const key of required) if (!options.has(key)) throw new Error(`Missing --${key}`)
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

if (import.meta.main) await main()
