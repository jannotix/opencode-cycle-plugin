import { expect, test } from "bun:test"

import { buildPublicationPlan } from "./publication-plan.js"

const version = "1.0.0"
const revision = "e".repeat(40)

// Native archives publish before the plugin, so an installation can never
// resolve a plugin whose native package does not exist yet.
const archives = [
  "opencode-cycle-native-darwin-arm64-1.0.0.tgz",
  "opencode-cycle-native-darwin-x64-1.0.0.tgz",
  "opencode-cycle-native-linux-x64-1.0.0.tgz",
  "opencode-cycle-native-win32-x64-1.0.0.tgz",
  "opencode-cycle-1.0.0.tgz",
]

function releaseManifest() {
  return {
    artifacts: archives.map((name) => ({ name, sha256: "a".repeat(64), size: 1 })),
    certifications: [
      { evidenceSha256: "b".repeat(64), platform: "linux-x64", status: "certified" },
      { evidenceSha256: "b".repeat(64), platform: "windows-x64", status: "certified" },
    ],
    compatibility: [
      { platform: "darwin-arm64", status: "compatible-but-untested" },
      { platform: "darwin-x64", status: "compatible-but-untested" },
    ],
    product: "Cycle for OpenCode",
    qualityEvidence: [
      { evidenceSha256: "c".repeat(64), name: "codebase-500k" },
      { evidenceSha256: "d".repeat(64), name: "critical-suite" },
    ],
    revision,
    schemaVersion: 2,
    version,
  }
}

test("publication plan requires the certified revision and publishes the plugin last", () => {
  const manifest = releaseManifest()

  expect(buildPublicationPlan(manifest, version, revision)).toEqual(archives)
  expect(buildPublicationPlan(manifest, version, revision).at(-1)).toBe("opencode-cycle-1.0.0.tgz")
  expect(() => buildPublicationPlan(manifest, version, "f".repeat(40))).toThrow("revision")
})

test("publication stops when an untested platform is presented as certified", () => {
  const certifiedMacOs = releaseManifest()
  certifiedMacOs.certifications = [
    ...certifiedMacOs.certifications,
    { evidenceSha256: "b".repeat(64), platform: "darwin-x64", status: "certified" },
  ]
  expect(() => buildPublicationPlan(certifiedMacOs, version, revision)).toThrow(
    /desktop certification|must not be certified/u,
  )

  const upgradedStatus = releaseManifest()
  upgradedStatus.compatibility = upgradedStatus.compatibility.map((item) =>
    item.platform === "darwin-x64" ? { ...item, status: "certified" } : item)
  expect(() => buildPublicationPlan(upgradedStatus, version, revision)).toThrow(
    /platform compatibility/u,
  )
})

test("publication stops when the untested platforms are not declared at all", () => {
  const missing = releaseManifest()
  missing.compatibility = []
  expect(() => buildPublicationPlan(missing, version, revision)).toThrow(/platform compatibility/u)

  const legacySchema = releaseManifest()
  legacySchema.schemaVersion = 1
  expect(() => buildPublicationPlan(legacySchema, version, revision)).toThrow("identity is invalid")
})
