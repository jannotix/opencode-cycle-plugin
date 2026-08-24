import { expect, test } from "bun:test"
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  desktopCertificationBindingDigest,
  desktopCertificationProcessToken,
  type DesktopCertificationBinding,
  type DesktopDaemonExitMarker,
  type DesktopDaemonRuntimeMarker,
} from "../../packages/opencode-cycle/src/certification.js"
import { cleanupCertifiedDaemon, type CertifiedShutdownAdapter } from "./certified-daemon.js"

function binding(root: string): DesktopCertificationBinding {
  return {
    nativePackageSha256: "d".repeat(64),
    nonce: "b".repeat(64),
    pluginPackageSha256: "c".repeat(64),
    revision: "a".repeat(40),
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
}

async function lifecycle(root: string) {
  const run = binding(root)
  const binary = join(root, process.platform === "win32" ? "workflowd.exe" : "workflowd")
  await writeFile(binary, "fixture")
  const daemon = {
    binaryPath: await realpath(binary),
    parentPid: process.pid,
    parentStartTimeUnixMillis: run.startedAtUnixMillis,
    pid: 4242,
    processStartTimeUnixMillis: run.startedAtUnixMillis,
    startToken: desktopCertificationProcessToken(run),
    startedAtUnixMillis: run.startedAtUnixMillis,
  }
  const runtime: DesktopDaemonRuntimeMarker = {
    daemon,
    runDigest: desktopCertificationBindingDigest(run),
    schemaVersion: 1,
    type: "opencode-cycle-desktop-daemon-runtime",
  }
  const exit: DesktopDaemonExitMarker = {
    ...runtime,
    stoppedAtUnixMillis: run.startedAtUnixMillis + 1,
    type: "opencode-cycle-desktop-daemon-exit",
  }
  await writeFile(join(root, "desktop-daemon-runtime.json"), `${JSON.stringify(runtime)}\n`)
  return { binary, exit, run, runtime }
}

for (const platform of ["windows-x64", "linux-x64"] as const) {
  test(`authenticated ${platform} cleanup uses the daemon-owned marker before Desktop termination`, async () => {
    const root = await mkdtemp(join(tmpdir(), `cycle-auth-shutdown-${platform}-`))
    const fixture = await lifecycle(root)
    let shutdownCalls = 0
    let absenceCalls = 0
    const adapter: CertifiedShutdownAdapter = {
      async shutdown() {
        shutdownCalls += 1
        return {
          pid: fixture.runtime.daemon.pid,
          processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis,
          runDigest: fixture.runtime.runDigest,
        }
      },
      async waitForExit() { return fixture.exit },
      async waitForProcessAbsence(identity) {
        absenceCalls += 1
        expect(identity).toEqual(fixture.runtime.daemon)
      },
    }
    try {
      expect(await access(join(root, "desktop-daemon.json")).then(() => true, () => false)).toBe(false)
      await expect(cleanupCertifiedDaemon({
        binding: fixture.run,
        dataDirectory: join(root, "data"),
        expectedBinaryPath: fixture.binary,
        expectedDaemon: fixture.runtime.daemon,
        platform,
        shutdownAdapter: adapter,
      })).resolves.toMatchObject({
        exitMarkerPublished: true,
        markerPublished: true,
        parentPid: fixture.runtime.daemon.parentPid,
        parentStartTimeUnixMillis: fixture.runtime.daemon.parentStartTimeUnixMillis,
        processAbsent: true,
        processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis,
        runDigest: fixture.runtime.runDigest,
        shutdownAuthenticated: true,
        terminated: true,
      })
      expect(shutdownCalls).toBe(1)
      expect(absenceCalls).toBe(1)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
    expect(await access(root).then(() => true, () => false)).toBe(false)
  })

  test(`${platform} activation failure still authenticates cleanup from the runtime marker`, async () => {
    const root = await mkdtemp(join(tmpdir(), `cycle-activation-failure-${platform}-`))
    const fixture = await lifecycle(root)
    let shutdownCalls = 0
    try {
      await expect(cleanupCertifiedDaemon({
        binding: fixture.run,
        dataDirectory: join(root, "data"),
        expectedBinaryPath: fixture.binary,
        platform,
        shutdownAdapter: {
          async shutdown() {
            shutdownCalls += 1
            return {
              pid: fixture.runtime.daemon.pid,
              processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis,
              runDigest: fixture.runtime.runDigest,
            }
          },
          async waitForExit() { return fixture.exit },
          async waitForProcessAbsence() {},
        },
      })).resolves.toMatchObject({
        markerPublished: true,
        processAbsent: true,
        shutdownAuthenticated: true,
      })
      expect(shutdownCalls).toBe(1)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test(`${platform} no-marker teardown skips authenticated shutdown`, async () => {
    const root = await mkdtemp(join(tmpdir(), `cycle-no-marker-${platform}-`))
    const run = binding(root)
    let shutdownCalls = 0
    try {
      await expect(cleanupCertifiedDaemon({
        binding: run,
        dataDirectory: join(root, "data"),
        expectedBinaryPath: join(root, "missing-workflowd"),
        platform,
        shutdownAdapter: {
          async shutdown() { shutdownCalls += 1; throw new Error("must not run") },
          async waitForExit() { throw new Error("must not run") },
          async waitForProcessAbsence() { throw new Error("must not run") },
        },
      })).resolves.toEqual({
        exitMarkerPublished: false,
        markerPublished: false,
        processAbsent: false,
        shutdownAuthenticated: false,
        terminated: false,
      })
      expect(shutdownCalls).toBe(0)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test(`${platform} cleanup never converts authenticated shutdown failure into success`, async () => {
    const root = await mkdtemp(join(tmpdir(), `cycle-parent-death-${platform}-`))
    const fixture = await lifecycle(root)
    let waits = 0
    let absenceChecks = 0
    try {
      await expect(cleanupCertifiedDaemon({
        binding: fixture.run,
        dataDirectory: join(root, "data"),
        expectedBinaryPath: fixture.binary,
        expectedDaemon: fixture.runtime.daemon,
        platform,
        shutdownAdapter: {
          async shutdown() { throw new Error("sidecar already exited") },
          async waitForExit() { waits += 1; return fixture.exit },
          async waitForProcessAbsence() { absenceChecks += 1 },
        },
      })).rejects.toThrow("sidecar already exited")
      expect(waits).toBe(0)
      expect(absenceChecks).toBe(0)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
    expect(await access(root).then(() => true, () => false)).toBe(false)
  })
}

test("authenticated cleanup rejects PID reuse without any OS termination primitive", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-auth-pid-reuse-"))
  const fixture = await lifecycle(root)
  let waited = false
  try {
    await expect(cleanupCertifiedDaemon({
      binding: fixture.run,
      dataDirectory: join(root, "data"),
      expectedBinaryPath: fixture.binary,
      expectedDaemon: fixture.runtime.daemon,
      platform: "windows-x64",
      shutdownAdapter: {
        async shutdown() {
          return {
            pid: fixture.runtime.daemon.pid + 1,
            processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis,
            runDigest: fixture.runtime.runDigest,
          }
        },
        async waitForExit() { waited = true; return fixture.exit },
        async waitForProcessAbsence() { throw new Error("process wait must not run") },
      },
    })).rejects.toThrow("identity mismatch")
    expect(waited).toBe(false)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
  expect(await access(root).then(() => true, () => false)).toBe(false)
})

test("authenticated cleanup rejects a mismatched daemon exit receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-auth-exit-mismatch-"))
  const fixture = await lifecycle(root)
  try {
    await expect(cleanupCertifiedDaemon({
      binding: fixture.run,
      dataDirectory: join(root, "data"),
      expectedBinaryPath: fixture.binary,
      expectedDaemon: fixture.runtime.daemon,
      platform: "windows-x64",
      shutdownAdapter: {
        async shutdown() {
          return {
            pid: fixture.runtime.daemon.pid,
            processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis,
            runDigest: fixture.runtime.runDigest,
          }
        },
        async waitForExit() {
          return { ...fixture.exit, runDigest: "e".repeat(64) }
        },
        async waitForProcessAbsence() { throw new Error("process wait must not run") },
      },
    })).rejects.toThrow("exit receipt")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
  expect(await access(root).then(() => true, () => false)).toBe(false)
})

test("cleanup rejects an activation/runtime identity race before authenticated shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-auth-activation-mismatch-"))
  const fixture = await lifecycle(root)
  let shutdownCalls = 0
  try {
    await expect(cleanupCertifiedDaemon({
      binding: fixture.run,
      dataDirectory: join(root, "data"),
      expectedBinaryPath: fixture.binary,
      expectedDaemon: {
        ...fixture.runtime.daemon,
        processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis + 1_000,
      },
      platform: "linux-x64",
      shutdownAdapter: {
        async shutdown() {
          shutdownCalls += 1
          return {
            pid: fixture.runtime.daemon.pid,
            processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis,
            runDigest: fixture.runtime.runDigest,
          }
        },
        async waitForExit() { return fixture.exit },
        async waitForProcessAbsence() { throw new Error("process wait must not run") },
      },
    })).rejects.toThrow("identities do not match")
    expect(shutdownCalls).toBe(0)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
  expect(await access(root).then(() => true, () => false)).toBe(false)
})

test("cleanup cannot claim absence while the exact daemon process instance remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-auth-process-present-"))
  const fixture = await lifecycle(root)
  try {
    await expect(cleanupCertifiedDaemon({
      binding: fixture.run,
      dataDirectory: join(root, "data"),
      expectedBinaryPath: fixture.binary,
      expectedDaemon: fixture.runtime.daemon,
      platform: "windows-x64",
      shutdownAdapter: {
        async shutdown() {
          return {
            pid: fixture.runtime.daemon.pid,
            processStartTimeUnixMillis: fixture.runtime.daemon.processStartTimeUnixMillis,
            runDigest: fixture.runtime.runDigest,
          }
        },
        async waitForExit() { return fixture.exit },
        async waitForProcessAbsence(identity) {
          expect(identity).toEqual(fixture.runtime.daemon)
          throw new Error("exact process instance remains")
        },
      },
    })).rejects.toThrow("process instance remains")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
  expect(await access(root).then(() => true, () => false)).toBe(false)
})
