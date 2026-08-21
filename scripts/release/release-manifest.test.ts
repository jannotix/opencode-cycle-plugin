import { describe, expect, test } from "bun:test"

import {
  buildReleaseManifest,
  CERTIFIED_PLATFORMS,
  classifyCertificationEvidence,
  DECLARED_DESKTOP_PLATFORMS,
} from "./release-manifest.js"

const qualityEvidence = [
  { evidenceSha256: "5".repeat(64), name: "codebase-500k" as const },
  { evidenceSha256: "6".repeat(64), name: "critical-suite" as const },
]

describe("release manifest", () => {
  test("v1 declares only Windows x64 and Linux x64", () => {
    expect(DECLARED_DESKTOP_PLATFORMS).toEqual(["linux-x64", "windows-x64"])
    expect(CERTIFIED_PLATFORMS).toEqual(["linux-x64", "windows-x64"])
  })
  test("sorts artifacts and rejects missing certification lanes", () => {
    expect(() =>
      buildReleaseManifest({
        artifacts: [{ name: "plugin.tgz", sha256: "a".repeat(64), size: 1 }],
        certifications: [{ evidenceSha256: "b".repeat(64), platform: "windows-x64", status: "certified" }],
        qualityEvidence,
        revision: "c".repeat(40),
        version: "0.1.0",
      }),
    ).toThrow("linux-x64")
  })

  test("rejects unsupported Desktop certification evidence", () => {
    expect(() =>
      classifyCertificationEvidence({
        activationMarker: "Cycle for OpenCode activated",
        controlPlane: { protocolVersion: 1, schemaVersion: 17 },
        platform: "macos-x64",
      }),
    ).toThrow("invalid platform")
  })

  test("binds every certified platform and artifact deterministically", () => {
    const input = {
      artifacts: [
        { name: "z.tgz", sha256: "f".repeat(64), size: 2 },
        { name: "a.tgz", sha256: "e".repeat(64), size: 1 },
      ],
      certifications: [
        { evidenceSha256: "2".repeat(64), platform: "linux-x64" as const, status: "certified" as const },
        { evidenceSha256: "1".repeat(64), platform: "windows-x64" as const, status: "certified" as const },
      ],
      qualityEvidence: [...qualityEvidence].reverse(),
      revision: "c".repeat(40),
      version: "0.1.0",
    }

    const manifest = buildReleaseManifest(input)

    expect(manifest.product).toBe("Cycle for OpenCode")
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual(["a.tgz", "z.tgz"])
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
    expect(
      classifyCertificationEvidence({
        activationMarker: "Cycle for OpenCode activated",
        controlPlane: { protocolVersion: 1, schemaVersion: 17 },
        platform: "windows-x64",
      }),
    ).toEqual({ kind: "desktop", platform: "windows-x64" })
    expect(
      classifyCertificationEvidence({
        corpus: { inventoriedFiles: 500_100, parsedFiles: 500_100, physicalFiles: 520_101 },
        passed: true,
      }),
    ).toEqual({ kind: "quality", name: "codebase-500k" })
    expect(
      classifyCertificationEvidence({
        completedIterations: 20,
        passed: true,
        requestedIterations: 20,
      }),
    ).toEqual({ kind: "quality", name: "critical-suite" })
    expect(() =>
      classifyCertificationEvidence({
        completedIterations: 19,
        passed: false,
        requestedIterations: 20,
      }),
    ).toThrow("failed")
  })
})
