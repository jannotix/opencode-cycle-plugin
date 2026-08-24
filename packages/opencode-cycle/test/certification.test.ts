import { expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildDesktopActivationMarker,
  certificationBindingFromOptions,
  createDesktopActivationWriterForTests,
  desktopCertificationBindingDigest,
  desktopCertificationProcessToken,
  finalizeDesktopActivation,
  parseDesktopActivationMarker,
  type DesktopCertificationBinding,
  writeDesktopActivationMarker,
} from "../src/certification.js"

const revision = "a".repeat(40)
const nonce = "b".repeat(64)
const pluginPackageSha256 = "c".repeat(64)
const nativePackageSha256 = "d".repeat(64)

const health = {
  product_version: "1.0.0",
  protocol_version: 1,
  schema_mode: "read_write" as const,
  schema_version: 17,
}

function daemon(binding: DesktopCertificationBinding) {
  return {
    binaryPath: join(binding.root, process.platform === "win32" ? "workflowd.exe" : "workflowd"),
    parentPid: process.pid,
    parentStartTimeUnixMillis: binding.startedAtUnixMillis,
    pid: 4242,
    processStartTimeUnixMillis: binding.startedAtUnixMillis,
    startToken: desktopCertificationProcessToken(binding),
    startedAtUnixMillis: binding.startedAtUnixMillis,
  }
}

const finalizationStages = [
  "certification_env_prepared",
  "config_tree_prepared",
  "config_path_discovered",
  "plugin_specifier_resolved",
  "effective_env_validated",
  "candidate_module_resolved",
  "plugin_entry_started",
  "plugin_entry_completed",
  "daemon_identity_published",
] as const

async function writeFinalizationEvidence(
  binding: DesktopCertificationBinding,
  records: readonly unknown[] = finalizationStages.map((stage, sequence) => ({
    runDigest: desktopCertificationBindingDigest(binding),
    schemaVersion: 2,
    sequence,
    stage,
    status: "passed",
    type: "opencode-cycle-desktop-load-diagnostic",
  })),
): Promise<string> {
  const identity = daemon(binding)
  await writeFile(join(binding.root, "desktop-daemon-runtime.json"), `${JSON.stringify({
    daemon: identity,
    runDigest: desktopCertificationBindingDigest(binding),
    schemaVersion: 1,
    type: "opencode-cycle-desktop-daemon-runtime",
  })}\n`)
  const diagnostics = join(binding.root, "desktop-load-diagnostics.jsonl")
  await writeFile(diagnostics, `${records.map((record) =>
    typeof record === "string" ? record : JSON.stringify(record)).join("\n")}\n`)
  return diagnostics
}

test("certification binding requires matching isolated environment authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-binding-"))
  try {
    const value = {
      nativePackageSha256,
      nonce,
      pluginPackageSha256,
      revision,
      root,
      startedAtUnixMillis: 1_700_000_000_000,
    }
    expect(
      certificationBindingFromOptions(
        { certification: value },
        { CYCLE_CERTIFICATION_NONCE: nonce, CYCLE_CERTIFICATION_ROOT: root },
      ),
    ).toEqual(value)
    expect(() =>
      certificationBindingFromOptions(
        { certification: value },
        { CYCLE_CERTIFICATION_NONCE: "e".repeat(64), CYCLE_CERTIFICATION_ROOT: root },
      ),
    ).toThrow("nonce")
    expect(() =>
      certificationBindingFromOptions(
        { certification: value },
        { CYCLE_CERTIFICATION_NONCE: nonce, CYCLE_CERTIFICATION_ROOT: join(root, "other") },
      ),
    ).toThrow("root")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("Desktop-loaded health produces one strict nonce and package-bound activation marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-marker-"))
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  try {
    const processIdentity = daemon(binding)
    const marker = buildDesktopActivationMarker(binding, health, processIdentity, 1_700_000_000_100)
    expect(marker.daemon).toEqual(processIdentity)
    expect(marker.runDigest).toBe(desktopCertificationBindingDigest(binding))
    expect(marker.schemaVersion).toBe(2)
    expect(parseDesktopActivationMarker(marker)).toEqual(marker)
    await writeDesktopActivationMarker(binding, health, daemon(binding), () => 1_700_000_000_100)
    expect(
      parseDesktopActivationMarker(
        JSON.parse(await readFile(join(root, "desktop-activation.json"), "utf8")) as unknown,
      ),
    ).toEqual(marker)
    await expect(
      writeDesktopActivationMarker(binding, health, daemon(binding), () => 1_700_000_000_101),
    ).resolves.toEqual(marker)
    await expect(
      writeDesktopActivationMarker(
        { ...binding, nonce: "e".repeat(64) },
        health,
        daemon({ ...binding, nonce: "e".repeat(64) }),
        () => 1_700_000_000_101,
      ),
    ).rejects.toThrow("another binding")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("activation marker rejects missing or non-candidate Desktop health", () => {
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root: "C:\\isolated",
    startedAtUnixMillis: 1_700_000_000_000,
  }
  for (const invalid of [
    { ...health, product_version: "9.9.9" },
    { ...health, protocol_version: 2 },
    { ...health, schema_mode: "safe_read_only" },
    { ...health, schema_version: 18 },
  ]) {
    expect(() => buildDesktopActivationMarker(binding, invalid as never, daemon(binding), 1_700_000_000_100)).toThrow(
      "health",
    )
  }
  expect(() => buildDesktopActivationMarker(
    binding,
    health,
    { ...daemon(binding), startToken: "e".repeat(64) },
    1_700_000_000_100,
  )).toThrow("daemon")
  expect(() => buildDesktopActivationMarker(
    binding,
    health,
    { ...daemon(binding), binaryPath: "relative" },
    1_700_000_000_100,
  )).toThrow("daemon")
})

test("candidate finalization publishes only after the exact run-bound transcript and daemon identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-finalizer-"))
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  try {
    const diagnostics = await writeFinalizationEvidence(binding)
    const marker = await finalizeDesktopActivation(binding, health, daemon(binding), diagnostics)
    expect(marker.daemon).toEqual(daemon(binding))
    expect(marker.runDigest).toBe(desktopCertificationBindingDigest(binding))
    expect(parseDesktopActivationMarker(
      JSON.parse(await readFile(join(root, "desktop-activation.json"), "utf8")) as unknown,
    )).toEqual(marker)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("candidate finalization rejects malformed, reordered, stale, failed and secret-bearing transcripts", async () => {
  const privateDetail = "C:\\private\\provider-model-token"
  for (const scenario of ["malformed", "reordered", "stale", "failed", "extra"] as const) {
    const root = await mkdtemp(join(tmpdir(), `cycle-cert-finalizer-${scenario}-`))
    const binding = {
      nativePackageSha256,
      nonce,
      pluginPackageSha256,
      revision,
      root,
      startedAtUnixMillis: 1_700_000_000_000,
    }
    const records: unknown[] = finalizationStages.map((stage, sequence) => ({
      runDigest: desktopCertificationBindingDigest(binding),
      schemaVersion: 2,
      sequence,
      stage,
      status: "passed",
      type: "opencode-cycle-desktop-load-diagnostic",
    }))
    if (scenario === "malformed") records[8] = `{${privateDetail}`
    if (scenario === "reordered") records[1] = { ...(records[1] as object), stage: finalizationStages[0] }
    if (scenario === "stale") records[8] = { ...(records[8] as object), runDigest: "e".repeat(64) }
    if (scenario === "failed") records[8] = { ...(records[8] as object), status: "failed" }
    if (scenario === "extra") records[8] = { ...(records[8] as object), detail: privateDetail }
    try {
      const diagnostics = await writeFinalizationEvidence(binding, records)
      let failure: unknown
      try {
        await finalizeDesktopActivation(binding, health, daemon(binding), diagnostics)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).not.toContain(privateDetail)
      expect(await access(join(root, "desktop-activation.json")).then(() => true, () => false)).toBe(false)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }
})

test("candidate finalization rejects a runtime identity mismatch before activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-finalizer-daemon-"))
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  try {
    const diagnostics = await writeFinalizationEvidence(binding)
    await expect(finalizeDesktopActivation(
      binding,
      health,
      { ...daemon(binding), processStartTimeUnixMillis: binding.startedAtUnixMillis + 1_000 },
      diagnostics,
    )).rejects.toThrow("identity mismatch")
    expect(await access(join(root, "desktop-activation.json")).then(() => true, () => false)).toBe(false)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("activation final is absent while the private temp is paused and publishes atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-atomic-"))
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root,
    startedAtUnixMillis: Date.now(),
  }
  let release: (() => void) | undefined
  const paused = new Promise<void>((resolve) => { release = resolve })
  let reached = false
  const writer = createDesktopActivationWriterForTests({
    async afterTempSynced(path) {
      reached = true
      expect(await readFile(path, "utf8")).toContain("opencode-cycle-desktop-activation")
      expect(await access(join(root, "desktop-activation.json")).then(() => true, () => false)).toBeFalse()
      await paused
    },
  })
  try {
    const first = writer(binding, health, daemon(binding), Date.now)
    while (!reached) await Bun.sleep(1)
    const second = writer(binding, health, daemon(binding), Date.now)
    await Bun.sleep(20)
    expect(await access(join(root, "desktop-activation.json")).then(() => true, () => false)).toBeFalse()
    release?.()
    const [left, right] = await Promise.all([first, second])
    expect(right).toEqual(left)
    expect(parseDesktopActivationMarker(JSON.parse(await readFile(join(root, "desktop-activation.json"), "utf8")))).toEqual(left)
  } finally {
    release?.()
    await rm(root, { force: true, recursive: true })
  }
})

test("activation temp and lock are cleaned on failure and partial finals are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-atomic-failure-"))
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root,
    startedAtUnixMillis: Date.now(),
  }
  try {
    const failing = createDesktopActivationWriterForTests({
      async afterTempSynced() { throw new Error("injected publication failure") },
    })
    await expect(failing(binding, health, daemon(binding), Date.now)).rejects.toThrow("injected")
    expect((await Array.fromAsync(new Bun.Glob("desktop-activation*").scan({ cwd: root })))).toEqual([])

    await writeFile(join(root, "desktop-activation.json"), "{\"partial\":true")
    await expect(writeDesktopActivationMarker(binding, health, daemon(binding))).rejects.toThrow()
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
