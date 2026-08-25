import { expect, test } from "bun:test"

import {
  authoritativePluginPackageMode,
  validateAuthoritativePluginProvenance,
} from "./authoritative-plugin-package.js"

test("official guards require an authoritative prebuilt plugin and cannot select repacking", () => {
  expect(authoritativePluginPackageMode({ official: false })).toBe("local-repack")
  expect(() => authoritativePluginPackageMode({ official: true })).toThrow("prebuilt")
  expect(() => authoritativePluginPackageMode({
    archive: "plugin.tgz",
    official: true,
  })).toThrow("provenance")
  expect(authoritativePluginPackageMode({
    archive: "plugin.tgz",
    official: true,
    provenance: "plugin.tgz.provenance.json",
  })).toBe("authoritative-prebuilt")
})

test("authoritative plugin provenance rejects archive, lock, source and builder drift", () => {
  const value = provenance()
  const expected = {
    archiveBytes: value.archiveBytes,
    archiveName: value.archiveName,
    archiveSha256: value.archiveSha256,
    bunLockSha256: value.bunLockSha256,
    pluginManifestSha256: value.pluginManifestSha256,
    revision: value.revision,
    workspaceManifestSha256: value.workspaceManifestSha256,
  }
  expect(() => validateAuthoritativePluginProvenance(value, expected)).not.toThrow()
  for (const [label, changed] of [
    ["archive bytes", { archiveBytes: value.archiveBytes + 1 }],
    ["archive name", { archiveName: "replacement.tgz" }],
    ["archive digest", { archiveSha256: "f".repeat(64) }],
    ["lock digest", { bunLockSha256: "f".repeat(64) }],
    ["plugin manifest", { pluginManifestSha256: "f".repeat(64) }],
    ["revision", { revision: "f".repeat(40) }],
    ["workspace manifest", { workspaceManifestSha256: "f".repeat(64) }],
    ["builder platform", { buildPlatform: "win32" }],
    ["builder architecture", { buildArch: "arm64" }],
    ["builder Bun", { bunVersion: "1.3.13" }],
  ] as const) {
    expect(
      () => validateAuthoritativePluginProvenance({ ...value, ...changed }, expected),
      label,
    ).toThrow()
  }
})

function provenance() {
  return {
    archiveBytes: 123,
    archiveName: "opencode-cycle-1.0.0.tgz",
    archiveSha256: "a".repeat(64),
    buildArch: "x64",
    buildPlatform: "linux",
    bunLockSha256: "b".repeat(64),
    bunVersion: "1.3.14",
    pluginManifestSha256: "c".repeat(64),
    revision: "d".repeat(40),
    schemaVersion: 1,
    type: "opencode-cycle-authoritative-plugin-package",
    workspaceManifestSha256: "e".repeat(64),
  }
}
