import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  buildReleaseManifest,
  CERTIFIED_PLATFORMS,
  classifyCertificationEvidence,
  DECLARED_DESKTOP_PLATFORMS,
} from "./release-manifest.js"

const revision = "c".repeat(40)
const otherRevision = "d".repeat(40)
const version = "1.0.0"

const qualityEvidence = [
  { evidenceSha256: "5".repeat(64), name: "codebase-500k" as const, revision },
  { evidenceSha256: "6".repeat(64), name: "critical-suite" as const, revision },
]

const expectedArtifactContents = new Map([
  [`opencode-cycle-${version}.tgz`, "plugin"],
  [`opencode-cycle-native-linux-x64-${version}.tgz`, "linux"],
  [`opencode-cycle-native-win32-x64-${version}.tgz`, "windows"],
])

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function manifestArtifacts() {
  return [...expectedArtifactContents].map(([name, content]) => ({
    name,
    sha256: digest(content),
    size: Buffer.byteLength(content),
  }))
}

function manifestCertifications() {
  const artifacts = new Map(manifestArtifacts().map((artifact) => [artifact.name, artifact]))
  const plugin = artifacts.get(`opencode-cycle-${version}.tgz`) as ReturnType<typeof manifestArtifacts>[number]
  return (["linux-x64", "windows-x64"] as const).map((platform, index) => {
    const nativeTarget = platform === "windows-x64" ? "win32-x64" : "linux-x64"
    const native = artifacts.get(`opencode-cycle-native-${nativeTarget}-${version}.tgz`) as typeof plugin
    return {
      evidenceSha256: String(index + 1).repeat(64),
      nativeArtifact: { name: native.name, sha256: native.sha256 },
      platform,
      pluginArtifact: { name: plugin.name, sha256: plugin.sha256 },
      revision,
      status: "certified" as const,
    }
  })
}

function certificationEvidence(targetRevision = revision): Record<string, unknown>[] {
  const pluginPackageSha256 = digest(expectedArtifactContents.get(`opencode-cycle-${version}.tgz`) as string)
  const desktop = (platform: "linux-x64" | "windows-x64", nativeName: string) => ({
    activationLogSha256: "7".repeat(64),
    activationMarker: "Cycle for OpenCode activated",
    controlPlane: {
      productVersion: "1.0.0",
      protocolVersion: 1,
      schemaMode: "current",
      schemaVersion: 17,
    },
    desktop: {
      asset: platform === "windows-x64"
        ? "opencode-desktop-win-x64.exe"
        : "opencode-desktop-linux-x86_64.AppImage",
      authenticity: "fixture",
      profileIsolation: "official-test-profile",
      sha256: "8".repeat(64),
      version: "1.18.21",
    },
    nativePackageSha256: digest(expectedArtifactContents.get(nativeName) as string),
    platform,
    pluginPackageSha256,
    revision: targetRevision,
    schemaVersion: 1,
  })
  return [
    desktop("linux-x64", `opencode-cycle-native-linux-x64-${version}.tgz`),
    desktop("windows-x64", `opencode-cycle-native-win32-x64-${version}.tgz`),
    {
      corpus: {
        inventoriedFiles: 500_101,
        parsedFiles: 500_100,
        physicalFiles: 520_101,
        sourceFiles: 500_100,
      },
      graph: { oracleRouteFound: true, parseErrors: 0, queryNodes: 1 },
      incremental: { deletedRemoved: true, modifiedFound: true, renamedFound: true },
      passed: true,
      resources: { peakMemoryPercent: 10 },
      revision: targetRevision,
      schemaVersion: 1,
      timingsMs: { inventoryAndIndex: 1_000, total: 2_000 },
    },
    {
      architecture: "x64",
      completedIterations: 20,
      iterations: Array.from({ length: 20 }, () => ({ durationMs: 1 })),
      operatingSystem: "linux",
      passed: true,
      requestedIterations: 20,
      revision: targetRevision,
      schemaVersion: 1,
    },
  ]
}

async function runManifestFixture(options: {
  artifacts?: ReadonlyMap<string, string>
  evidence?: readonly Record<string, unknown>[]
} = {}): Promise<{ exitCode: number; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "opencode-cycle-release-manifest-"))
  const artifactsDirectory = join(root, "artifacts")
  const certificationsDirectory = join(root, "certifications")
  try {
    await Promise.all([
      mkdir(artifactsDirectory, { recursive: true }),
      mkdir(certificationsDirectory, { recursive: true }),
    ])
    for (const [name, content] of options.artifacts ?? expectedArtifactContents) {
      const path = join(artifactsDirectory, name)
      await mkdir(resolve(path, ".."), { recursive: true })
      await writeFile(path, content)
    }
    for (const [index, evidence] of (options.evidence ?? certificationEvidence()).entries()) {
      await writeFile(join(certificationsDirectory, `${index}.json`), `${JSON.stringify(evidence)}\n`)
    }
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "release-manifest.ts"),
        "--artifacts-directory",
        artifactsDirectory,
        "--certifications-directory",
        certificationsDirectory,
        "--revision",
        revision,
        "--version",
        version,
        "--output",
        join(root, "release-manifest.json"),
      ],
      { stderr: "pipe", stdout: "pipe" },
    )
    const stderr = await new Response(child.stderr).text()
    return { exitCode: await child.exited, stderr }
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("release manifest", () => {
  test("v1 declares only Windows x64 and Linux x64", () => {
    expect(DECLARED_DESKTOP_PLATFORMS).toEqual(["linux-x64", "windows-x64"])
    expect(CERTIFIED_PLATFORMS).toEqual(["linux-x64", "windows-x64"])
  })
  test("sorts artifacts and rejects missing certification lanes", () => {
    expect(() =>
      buildReleaseManifest({
        artifacts: manifestArtifacts(),
        certifications: [manifestCertifications()[1] as ReturnType<typeof manifestCertifications>[number]],
        qualityEvidence,
        revision,
        version,
      }),
    ).toThrow("linux-x64")
  })

  test("rejects a missing Windows or Linux release artifact", async () => {
    const artifacts = new Map(expectedArtifactContents)
    artifacts.delete(`opencode-cycle-native-linux-x64-${version}.tgz`)
    expect((await runManifestFixture({ artifacts })).exitCode).not.toBe(0)
  })

  test("rejects any macOS release material", async () => {
    const artifacts = new Map(expectedArtifactContents)
    artifacts.set(`opencode-cycle-native-darwin-x64-${version}.tgz`, "macos")
    expect((await runManifestFixture({ artifacts })).exitCode).not.toBe(0)
  })

  test("rejects a receipt bound to a different revision", async () => {
    const evidence = certificationEvidence()
    evidence[2] = { ...evidence[2], revision: otherRevision }
    expect((await runManifestFixture({ evidence })).exitCode).not.toBe(0)
  })

  test("rejects Desktop receipts whose package digests do not match the exact artifacts", async () => {
    const evidence = certificationEvidence()
    evidence[0] = { ...evidence[0], pluginPackageSha256: "f".repeat(64) }
    expect((await runManifestFixture({ evidence })).exitCode).not.toBe(0)
  })

  test("rejects duplicate artifact basenames", async () => {
    const artifacts = new Map(expectedArtifactContents)
    artifacts.set(`duplicate/opencode-cycle-${version}.tgz`, "duplicate")
    const result = await runManifestFixture({ artifacts })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Duplicate artifact")
  })

  test("rejects missing Desktop receipts and failed scale or repeatability receipts", async () => {
    const missingLinux = certificationEvidence().filter((item) => item.platform !== "linux-x64")
    expect((await runManifestFixture({ evidence: missingLinux })).exitCode).not.toBe(0)

    const failedScale = certificationEvidence()
    failedScale[2] = { ...failedScale[2], passed: false }
    expect((await runManifestFixture({ evidence: failedScale })).exitCode).not.toBe(0)

    const failedRepeat = certificationEvidence()
    failedRepeat[3] = { ...failedRepeat[3], completedIterations: 19, passed: false }
    expect((await runManifestFixture({ evidence: failedRepeat })).exitCode).not.toBe(0)
  })

  test("rejects unsupported Desktop certification evidence", () => {
    expect(() =>
      classifyCertificationEvidence({
        activationMarker: "Cycle for OpenCode activated",
        controlPlane: { protocolVersion: 1, schemaVersion: 17 },
        platform: "macos-x64",
        revision,
        schemaVersion: 1,
      }),
    ).toThrow("invalid platform")
  })

  test("binds every certified platform and artifact deterministically", () => {
    const input = {
      artifacts: manifestArtifacts().reverse(),
      certifications: manifestCertifications().reverse(),
      qualityEvidence: [...qualityEvidence].reverse(),
      revision,
      version,
    }

    const manifest = buildReleaseManifest(input)

    expect(manifest.product).toBe("Cycle for OpenCode")
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      `opencode-cycle-${version}.tgz`,
      `opencode-cycle-native-linux-x64-${version}.tgz`,
      `opencode-cycle-native-win32-x64-${version}.tgz`,
    ])
    expect(manifest.certifications.map((item) => item.platform)).toEqual([
      "linux-x64",
      "windows-x64",
    ])
    expect(manifest.certifications.map((item) => item.status)).toEqual([
      "certified",
      "certified",
    ])
    expect(manifest.qualityEvidence.map((item) => item.name)).toEqual([
      "codebase-500k",
      "critical-suite",
    ])
    expect(buildReleaseManifest(input)).toEqual(manifest)
  })

  test("requires passed scale and repeatability evidence", () => {
    const evidence = certificationEvidence()
    expect(
      classifyCertificationEvidence(evidence[1]),
    ).toMatchObject({ kind: "desktop", platform: "windows-x64", revision })
    expect(classifyCertificationEvidence(evidence[2])).toEqual({
      kind: "quality",
      name: "codebase-500k",
      revision,
    })
    expect(classifyCertificationEvidence(evidence[3])).toEqual({
      kind: "quality",
      name: "critical-suite",
      revision,
    })
    expect(() =>
      classifyCertificationEvidence({ ...evidence[3], completedIterations: 19, passed: false }),
    ).toThrow("failed")
  })

  test("Release Candidate directly depends on every source, package, platform and stress gate", async () => {
    const workflow = await Bun.file(resolve(import.meta.dir, "../../.github/workflows/release-candidate.yml")).text()
    expect(workflow).toContain(
      "needs: [quality, security, plugin, native, desktop, repeatability, scale]",
    )
    expect(workflow).toContain("  repeatability:\n")
    expect(workflow).toContain("run: bun run test:repeat-critical")
    expect(workflow).toContain("run: bun run test:scale:500k")
    expect(workflow.toLowerCase()).not.toContain("darwin")
    expect(workflow.toLowerCase()).not.toContain("macos")
    expect(workflow).not.toContain("npm publish")
    const actionReferences = [...workflow.matchAll(/uses:\s+\S+@([^\s]+)/gu)].map((match) => match[1])
    expect(actionReferences.length).toBeGreaterThan(0)
    expect(actionReferences.every((reference) => /^[0-9a-f]{40}$/u.test(reference as string))).toBeTrue()
  })
})
