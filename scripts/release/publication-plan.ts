import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { PRODUCT_IDENTITY, SHIPPED_NATIVE_PACKAGE_NAMES } from "../product-identity.js"
import {
  REQUIRED_CERTIFIED_PLATFORMS,
  QUALITY_EVIDENCE_NAMES,
} from "./release-manifest.js"

const PACKAGE_NAMES = [
  ...SHIPPED_NATIVE_PACKAGE_NAMES,
  PRODUCT_IDENTITY.mainPackage,
] as const

interface PublicationManifest {
  readonly artifacts: readonly { readonly name: string; readonly sha256: string; readonly size: number }[]
  readonly certifications: readonly { readonly platform: string; readonly status?: string }[]
  readonly product: string
  readonly qualityEvidence: readonly { readonly name: string }[]
  readonly revision: string
  readonly schemaVersion: number
  readonly version: string
}

export function buildPublicationPlan(
  manifest: PublicationManifest,
  version: string,
  revision: string,
): string[] {
  if (manifest.product !== PRODUCT_IDENTITY.product || manifest.schemaVersion !== 1) {
    throw new Error("Release manifest identity is invalid")
  }
  if (manifest.version !== version) throw new Error("Release manifest version does not match")
  if (manifest.revision !== revision) throw new Error("Release manifest revision does not match")
  requireExactSet(
    manifest.certifications
      .filter((item) => item.status === "certified")
      .map((item) => item.platform),
    REQUIRED_CERTIFIED_PLATFORMS,
    "desktop certification",
  )
  requireExactSet(
    manifest.qualityEvidence.map((item) => item.name),
    QUALITY_EVIDENCE_NAMES,
    "quality evidence",
  )
  const archives = PACKAGE_NAMES.map((name) => archiveName(name, version))
  const artifactNames = new Set(manifest.artifacts.map((item) => item.name))
  for (const archive of archives) {
    if (!artifactNames.has(archive)) throw new Error(`Release artifact is missing: ${archive}`)
  }
  return archives
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2))
  const candidate = resolve(options.candidate)
  const manifest = JSON.parse(
    await readFile(join(candidate, "release-manifest.json"), "utf8"),
  ) as PublicationManifest
  const archives = buildPublicationPlan(manifest, options.version, options.revision)
  for (const [index, archive] of archives.entries()) {
    const path = join(candidate, "artifacts", archive)
    const content = await readFile(path)
    const recorded = manifest.artifacts.find((item) => item.name === archive)
    if (
      recorded === undefined ||
      recorded.size !== content.byteLength ||
      recorded.sha256 !== createHash("sha256").update(content).digest("hex")
    ) {
      throw new Error(`Release artifact identity does not match: ${archive}`)
    }
    const packageManifest = await packedManifest(path)
    if (packageManifest.name !== PACKAGE_NAMES[index] || packageManifest.version !== options.version) {
      throw new Error(`Packed package identity does not match: ${archive}`)
    }
  }
  await writeFile(
    resolve(options.output),
    `${archives.map((archive) => join(candidate, "artifacts", archive)).join("\n")}\n`,
    "utf8",
  )
}

async function packedManifest(path: string): Promise<{ name?: unknown; version?: unknown }> {
  const process = Bun.spawn(["tar", "-xOf", path, "package/package.json"], {
    stderr: "inherit",
    stdout: "pipe",
  })
  const output = await new Response(process.stdout).text()
  if ((await process.exited) !== 0) throw new Error(`Cannot read packed manifest: ${path}`)
  return JSON.parse(output) as { name?: unknown; version?: unknown }
}

function archiveName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`
}

function requireExactSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const values = new Set(actual)
  if (values.size !== actual.length || values.size !== expected.length) {
    throw new Error(`Release manifest ${label} set is invalid`)
  }
  for (const value of expected) {
    if (!values.has(value)) throw new Error(`Release manifest is missing ${label}: ${value}`)
  }
}

function parseArguments(argumentsList: readonly string[]): {
  candidate: string
  output: string
  revision: string
  version: string
} {
  const values = new Map<string, string>()
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index]
    const value = argumentsList[index + 1]
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Publication arguments must be --key value pairs")
    }
    values.set(key.slice(2), value)
  }
  for (const key of ["candidate", "output", "revision", "version"]) {
    if (!values.has(key)) throw new Error(`Publication plan is missing --${key}`)
  }
  return Object.fromEntries(values) as {
    candidate: string
    output: string
    revision: string
    version: string
  }
}

if (import.meta.main) await main()
