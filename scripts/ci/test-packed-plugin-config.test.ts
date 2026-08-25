import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { posix, resolve } from "node:path"

import {
  MAX_LINUX_UNIX_SOCKET_PATH_BYTES,
} from "../../packages/opencode-cycle/src/endpoint-path.js"
import {
  packedPluginDaemonEndpointEvidence,
  packedPluginDataDirectory,
  packedPluginScratchPrefix,
} from "./packed-plugin-paths.js"

test("packed production gates build and package the release workflowd binary", async () => {
  const root = resolve(import.meta.dir, "../..")
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>
  }
  const pluginGate = await readFile(resolve(import.meta.dir, "test-packed-plugin.ts"), "utf8")
  const nativeGate = await readFile(resolve(import.meta.dir, "test-packed-native.ts"), "utf8")

  expect(manifest.scripts["test:package"]).toBe("bun scripts/ci/test-packed-plugin.ts")
  expect(manifest.scripts["test:native-package"]).toContain("cargo build -p workflowd --release")
  expect(pluginGate).toContain('await run(["cargo", "build", "-p", "workflowd", "--release"], root)')
  expect(pluginGate).toContain('join(root, "target", "release", executable)')
  expect(nativeGate).toContain('join(root, "target", "release", executable)')
  const evidenceEnvironment = pluginGate.indexOf("CYCLE_OFFICIAL_ELECTRON_EVIDENCE_DIR")
  const evidenceOpen = pluginGate.indexOf("await openOfficialRuntimeEvidenceDirectory(")
  const scratchCreation = pluginGate.indexOf("packedPluginScratchPrefix(process.platform)")
  const nativeBuild = pluginGate.indexOf('await run(["cargo", "build", "-p", "workflowd", "--release"], root)')
  const runtimeGuard = pluginGate.indexOf("await verifyDesktopModuleRuntime(")
  const evidenceMaterial = pluginGate.indexOf("serializeDesktopDependencyTreeManifest({")
  const hostProof = pluginGate.indexOf("proof = Bun.spawn(")
  const evidencePublication = pluginGate.indexOf("await officialEvidence.publish(")
  const failurePublication = pluginGate.indexOf("await officialEvidence.finalizeFailure(")
  const scratchCleanup = pluginGate.indexOf("rm(scratch, { force: true, recursive: true })")
  expect(evidenceEnvironment).toBeGreaterThan(0)
  expect(evidenceOpen).toBeGreaterThan(evidenceEnvironment)
  expect(scratchCreation).toBeGreaterThan(evidenceOpen)
  expect(nativeBuild).toBeGreaterThan(scratchCreation)
  expect(runtimeGuard).toBeGreaterThan(evidenceEnvironment)
  expect(evidenceMaterial).toBeGreaterThan(runtimeGuard)
  expect(hostProof).toBeGreaterThan(evidenceMaterial)
  expect(evidencePublication).toBeGreaterThan(runtimeGuard)
  expect(failurePublication).toBeGreaterThan(evidencePublication)
  expect(scratchCleanup).toBeGreaterThan(evidencePublication)
  expect(scratchCleanup).toBeGreaterThan(failurePublication)
  expect(pluginGate).not.toContain("windows-runtime-result.json")
  expect(pluginGate).not.toContain("CYCLE_R3_WINDOWS_EVIDENCE")
  for (const stage of [
    "host-proof-failed",
    "host-activation-finalized",
    "host-authenticated-shutdown",
    "host-daemon-absent",
  ]) expect(pluginGate).toContain(stage)
})

test("Linux package proof uses a short isolated endpoint while the prior production layout fails", async () => {
  const taskTmp = "/home/workflowci/opencode-cycle-linux-proof-a47b4d24/tmp"
  const priorData = posix.join(taskTmp, "opencode-cycle-packed-plugin-XXXXXX", "runtime-data")
  const shortData = posix.join(taskTmp, "ocp-XXXXXX", "d")
  expect(Buffer.byteLength(posix.join(priorData, "runtime", "workflow.sock"))).toBe(127)
  expect(Buffer.byteLength(posix.join(priorData, "runtime", "workflow.sock"))).toBeGreaterThan(
    MAX_LINUX_UNIX_SOCKET_PATH_BYTES,
  )
  expect(Buffer.byteLength(posix.join(shortData, "runtime", "workflow.sock"))).toBe(91)

  const scratch = resolve("C:\\task", `${packedPluginScratchPrefix("linux")}XXXXXX`)
  const dataDirectory = packedPluginDataDirectory(scratch, "linux")
  expect(packedPluginDaemonEndpointEvidence(dataDirectory, "linux").endpointPathBytes)
    .toBeLessThanOrEqual(MAX_LINUX_UNIX_SOCKET_PATH_BYTES)
  const rustTransport = await readFile(resolve(
    import.meta.dir,
    "../../crates/workflow-ipc/src/unix.rs",
  ), "utf8")
  expect(rustTransport).toContain(
    `MAX_UNIX_SOCKET_PATH_BYTES: usize = ${MAX_LINUX_UNIX_SOCKET_PATH_BYTES}`,
  )
})
