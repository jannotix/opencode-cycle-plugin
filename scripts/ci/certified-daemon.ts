import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { join, normalize } from "node:path"

import {
  desktopCertificationBindingDigest,
  desktopCertificationProcessToken,
  parseDesktopDaemonExitMarker,
  parseDesktopDaemonRuntimeMarker,
  type DesktopCertificationBinding,
  type DesktopDaemonExitMarker,
  type DesktopDaemonIdentity,
  type DesktopDaemonRuntimeMarker,
} from "../../packages/opencode-cycle/src/certification.js"
import {
  shutdownCertifiedControlPlane,
  type CertifiedShutdownReceipt,
} from "../../packages/opencode-cycle/src/control-plane.js"
import type { CertifiedPlatform } from "../release/release-manifest.js"
import { readVerifiedRegularFile } from "../release/verified-file.js"

export interface CertifiedShutdownAdapter {
  shutdown(): Promise<CertifiedShutdownReceipt>
  waitForExit(): Promise<DesktopDaemonExitMarker>
  waitForProcessAbsence(identity: DesktopDaemonIdentity): Promise<void>
}

export interface CertifiedDaemonCleanup {
  readonly binaryPathSha256?: string
  readonly exitMarkerPublished: boolean
  readonly markerPublished: boolean
  readonly parentPid?: number
  readonly parentStartTimeUnixMillis?: number
  readonly pid?: number
  readonly processAbsent: boolean
  readonly processStartTimeUnixMillis?: number
  readonly runDigest?: string
  readonly shutdownAuthenticated: boolean
  readonly startedAtUnixMillis?: number
  readonly startTokenSha256?: string
  readonly terminated: boolean
}

export async function cleanupCertifiedDaemon(input: {
  readonly binding: DesktopCertificationBinding
  readonly dataDirectory: string
  readonly expectedBinaryPath: string
  readonly expectedDaemon?: DesktopDaemonIdentity
  readonly platform: CertifiedPlatform
  readonly shutdownAdapter?: CertifiedShutdownAdapter
}): Promise<CertifiedDaemonCleanup> {
  const runtime = await readRuntimeMarker(input.binding.root)
  if (runtime === undefined) {
    return {
      exitMarkerPublished: false,
      markerPublished: false,
      processAbsent: false,
      shutdownAuthenticated: false,
      terminated: false,
    }
  }
  const expectedBinaryPath = await realpath(input.expectedBinaryPath)
  assertRuntimeBinding(runtime, input.binding, expectedBinaryPath, input.platform)
  if (
    input.expectedDaemon !== undefined &&
    !sameDaemonIdentity(runtime.daemon, input.expectedDaemon)
  ) throw new Error("Activation and daemon runtime identities do not match")
  const adapter = input.shutdownAdapter ?? realShutdownAdapter(
    input.dataDirectory,
    input.binding,
    expectedBinaryPath,
  )
  let receipt: CertifiedShutdownReceipt | undefined
  let exit: DesktopDaemonExitMarker | undefined
  try {
    receipt = await adapter.shutdown()
  } catch (error) {
    try {
      exit = await adapter.waitForExit()
    } catch {
      throw error
    }
  }
  if (
    receipt !== undefined &&
    (receipt.pid !== runtime.daemon.pid ||
      receipt.processStartTimeUnixMillis !== runtime.daemon.processStartTimeUnixMillis ||
      receipt.runDigest !== runtime.runDigest)
  ) throw new Error("Authenticated workflowd shutdown identity mismatch")
  exit ??= await adapter.waitForExit()
  if (
    exit.runDigest !== runtime.runDigest ||
    !sameDaemonIdentity(exit.daemon, runtime.daemon)
  ) throw new Error("Daemon exit receipt does not match its startup identity")
  await adapter.waitForProcessAbsence(runtime.daemon)
  return {
    binaryPathSha256: createHash("sha256").update(runtime.daemon.binaryPath).digest("hex"),
    exitMarkerPublished: true,
    markerPublished: true,
    parentPid: runtime.daemon.parentPid,
    parentStartTimeUnixMillis: runtime.daemon.parentStartTimeUnixMillis,
    pid: runtime.daemon.pid,
    processAbsent: true,
    processStartTimeUnixMillis: runtime.daemon.processStartTimeUnixMillis,
    runDigest: runtime.runDigest,
    shutdownAuthenticated: receipt !== undefined,
    startedAtUnixMillis: runtime.daemon.startedAtUnixMillis,
    startTokenSha256: createHash("sha256").update(runtime.daemon.startToken).digest("hex"),
    terminated: receipt !== undefined,
  }
}

function sameDaemonIdentity(left: DesktopDaemonIdentity, right: DesktopDaemonIdentity): boolean {
  return left.binaryPath === right.binaryPath &&
    left.parentPid === right.parentPid &&
    left.parentStartTimeUnixMillis === right.parentStartTimeUnixMillis &&
    left.pid === right.pid &&
    left.processStartTimeUnixMillis === right.processStartTimeUnixMillis &&
    left.startToken === right.startToken &&
    left.startedAtUnixMillis === right.startedAtUnixMillis
}

async function readRuntimeMarker(root: string): Promise<DesktopDaemonRuntimeMarker | undefined> {
  const path = join(root, "desktop-daemon-runtime.json")
  const file = await readVerifiedRegularFile(path, { maxBytes: 64 * 1024, root }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  if (file === undefined) return undefined
  return parseDesktopDaemonRuntimeMarker(JSON.parse(file.content.toString("utf8")) as unknown)
}

async function readExitMarker(root: string): Promise<DesktopDaemonExitMarker | undefined> {
  const path = join(root, "desktop-daemon-exit.json")
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (details === undefined) return undefined
  const file = await readVerifiedRegularFile(path, { maxBytes: 64 * 1024, root })
  return parseDesktopDaemonExitMarker(JSON.parse(file.content.toString("utf8")) as unknown)
}

function assertRuntimeBinding(
  runtime: DesktopDaemonRuntimeMarker,
  binding: DesktopCertificationBinding,
  expectedBinaryPath: string,
  platform: CertifiedPlatform,
): void {
  if (
    runtime.runDigest !== desktopCertificationBindingDigest(binding) ||
    runtime.daemon.startToken !== desktopCertificationProcessToken(binding) ||
    normalizeForPlatform(runtime.daemon.binaryPath, platform) !== normalizeForPlatform(expectedBinaryPath, platform)
  ) throw new Error("Daemon runtime marker does not match the certification run")
}

function realShutdownAdapter(
  dataDirectory: string,
  binding: DesktopCertificationBinding,
  expectedBinaryPath: string,
): CertifiedShutdownAdapter {
  return {
    shutdown: () => shutdownCertifiedControlPlane(
      dataDirectory,
      desktopCertificationProcessToken(binding),
      desktopCertificationBindingDigest(binding),
    ),
    async waitForExit() {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const marker = await readExitMarker(binding.root)
        if (marker !== undefined) return marker
        await Bun.sleep(50)
      }
      throw new Error("Certified workflowd did not publish its authenticated exit receipt")
    },
    async waitForProcessAbsence(identity) {
      const child = Bun.spawn([
        expectedBinaryPath,
        "--certification-wait-exit",
        String(identity.pid),
        "--certification-process-start",
        String(identity.processStartTimeUnixMillis),
      ], {
        stderr: "ignore",
        stdout: "ignore",
        windowsHide: true,
      })
      if (await child.exited !== 0) {
        throw new Error("Certified workflowd process instance did not exit")
      }
    },
  }
}

function normalizeForPlatform(path: string, platform: CertifiedPlatform): string {
  const value = normalize(path)
  return platform === "windows-x64"
    ? value.replace(/^\\\\\?\\/u, "").toLowerCase()
    : value
}
