import { expect, test } from "bun:test"

import { buildPublicationPlan } from "./publication-plan.js"

test("publication plan requires the certified revision and publishes the plugin last", () => {
  const version = "1.0.0"
  const archives = [
    "opencode-cycle-native-linux-x64-1.0.0.tgz",
    "opencode-cycle-native-win32-x64-1.0.0.tgz",
    "opencode-cycle-1.0.0.tgz",
  ]
  const manifest = {
    artifacts: archives.map((name) => ({ name, sha256: "a".repeat(64), size: 1 })),
    certifications: [
      { evidenceSha256: "b".repeat(64), platform: "linux-x64", status: "certified" },
      { evidenceSha256: "b".repeat(64), platform: "windows-x64", status: "certified" },
    ],
    product: "Cycle for OpenCode",
    qualityEvidence: [
      { evidenceSha256: "c".repeat(64), name: "codebase-500k" },
      { evidenceSha256: "d".repeat(64), name: "critical-suite" },
    ],
    revision: "e".repeat(40),
    schemaVersion: 1,
    version,
  }

  const plan = buildPublicationPlan(manifest, version, "e".repeat(40))

  expect(plan).toEqual(archives)
  expect(() => buildPublicationPlan(manifest, version, "f".repeat(40))).toThrow("revision")
})
