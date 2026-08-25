import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

test("packed production gates build and package the release workflowd binary", async () => {
  const root = resolve(import.meta.dir, "../..")
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>
  }
  const pluginGate = await readFile(resolve(import.meta.dir, "test-packed-plugin.ts"), "utf8")
  const nativeGate = await readFile(resolve(import.meta.dir, "test-packed-native.ts"), "utf8")

  expect(manifest.scripts["test:package"]).toContain("cargo build -p workflowd --release")
  expect(manifest.scripts["test:native-package"]).toContain("cargo build -p workflowd --release")
  expect(pluginGate).toContain('join(root, "target", "release", executable)')
  expect(nativeGate).toContain('join(root, "target", "release", executable)')
  const evidenceEnvironment = pluginGate.indexOf("CYCLE_OFFICIAL_ELECTRON_EVIDENCE_DIR")
  const runtimeGuard = pluginGate.indexOf("await verifyDesktopModuleRuntime(")
  const evidencePublication = pluginGate.indexOf("await officialEvidence.publish(")
  const scratchCleanup = pluginGate.indexOf("rm(scratch, { force: true, recursive: true })")
  expect(evidenceEnvironment).toBeGreaterThan(0)
  expect(runtimeGuard).toBeGreaterThan(evidenceEnvironment)
  expect(evidencePublication).toBeGreaterThan(runtimeGuard)
  expect(scratchCleanup).toBeGreaterThan(evidencePublication)
  expect(pluginGate).not.toContain("windows-runtime-result.json")
  expect(pluginGate).not.toContain("CYCLE_R3_WINDOWS_EVIDENCE")
})
