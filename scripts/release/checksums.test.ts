import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createChecksumManifest } from "./checksums.js"
import { buildReleaseManifest } from "./release-manifest.js"

test("checksum inventory exactly matches the release manifest artifact allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-cycle-checksums-"))
  try {
    const artifacts = join(root, "artifacts")
    const certifications = join(root, "certifications")
    await Promise.all([
      mkdir(artifacts),
      mkdir(certifications),
    ])
    const version = "1.0.0"
    const revision = "a".repeat(40)
    const contents = new Map([
      [`opencode-cycle-${version}.tgz`, Buffer.from("plugin")],
      [`opencode-cycle-native-darwin-arm64-${version}.tgz`, Buffer.from("darwin-arm64")],
      [`opencode-cycle-native-darwin-x64-${version}.tgz`, Buffer.from("darwin-x64")],
      [`opencode-cycle-native-linux-x64-${version}.tgz`, Buffer.from("linux")],
      [`opencode-cycle-native-win32-x64-${version}.tgz`, Buffer.from("windows")],
    ])
    await Promise.all(
      [...contents].map(([name, content]) => writeFile(join(artifacts, name), content)),
    )
    await writeFile(join(certifications, "windows-x64.json"), "{}")
    const releaseArtifacts = [...contents].map(([name, content]) => ({
      name,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
    }))
    const byName = new Map(releaseArtifacts.map((artifact) => [artifact.name, artifact]))
    const plugin = byName.get(`opencode-cycle-${version}.tgz`) as typeof releaseArtifacts[number]
    const certification = (platform: "linux-x64" | "windows-x64", nativeTarget: string) => {
      const native = byName.get(`opencode-cycle-native-${nativeTarget}-${version}.tgz`) as typeof plugin
      return {
        evidenceSha256: (platform === "linux-x64" ? "b" : "c").repeat(64),
        nativeArtifact: { name: native.name, sha256: native.sha256 },
        platform,
        pluginArtifact: { name: plugin.name, sha256: plugin.sha256 },
        revision,
        status: "certified" as const,
      }
    }
    const manifest = join(root, "release-manifest.json")
    await writeFile(
      manifest,
      `${JSON.stringify(buildReleaseManifest({
        artifacts: releaseArtifacts,
        certifications: [
          certification("linux-x64", "linux-x64"),
          certification("windows-x64", "win32-x64"),
        ],
        compatibility: (["darwin-arm64", "darwin-x64"] as const).map((platform) => {
          const native = byName.get(
            `opencode-cycle-native-${platform}-${version}.tgz`,
          ) as typeof plugin
          return {
            nativeArtifact: { name: native.name, sha256: native.sha256 },
            platform,
            status: "compatible-but-untested" as const,
          }
        }),
        qualityEvidence: [
          { evidenceSha256: "d".repeat(64), name: "codebase-500k", revision },
          { evidenceSha256: "e".repeat(64), name: "critical-suite", revision },
        ],
        revision,
        version,
      }))}\n`,
    )
    const output = join(root, "SHA256SUMS")

    await createChecksumManifest(root, output, manifest)

    const lines = (await Bun.file(output).text()).trim().split("\n")
    expect(lines.map((line) => line.split("  ")[1])).toEqual([
      `artifacts/opencode-cycle-${version}.tgz`,
      `artifacts/opencode-cycle-native-darwin-arm64-${version}.tgz`,
      `artifacts/opencode-cycle-native-darwin-x64-${version}.tgz`,
      `artifacts/opencode-cycle-native-linux-x64-${version}.tgz`,
      `artifacts/opencode-cycle-native-win32-x64-${version}.tgz`,
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
