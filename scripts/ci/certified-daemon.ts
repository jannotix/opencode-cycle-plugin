import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { join, normalize, win32 } from "node:path"

import {
  desktopCertificationBindingDigest,
  desktopCertificationProcessToken,
  parseDesktopDaemonMarker,
  type DesktopCertificationBinding,
  type DesktopDaemonMarker,
} from "../../packages/opencode-cycle/src/certification.js"
import type { CertifiedPlatform } from "../release/release-manifest.js"
import { readVerifiedRegularFile } from "../release/verified-file.js"

export interface CertifiedProcessSnapshot {
  readonly binaryPath: string
  readonly ownerTokenPresent: boolean
  readonly pid: number
}

export interface CertifiedProcessAdapter {
  inspect(pid: number): Promise<CertifiedProcessSnapshot | undefined>
  sleep(milliseconds: number): Promise<void>
  terminate(pid: number, force: boolean): Promise<void>
}

export interface CertifiedDaemonCleanup {
  readonly binaryPathSha256?: string
  readonly markerPublished: boolean
  readonly pid?: number
  readonly processAbsent: boolean
  readonly startedAtUnixMillis?: number
  readonly startTokenSha256?: string
  readonly terminated: boolean
}

export async function cleanupCertifiedDaemon(input: {
  readonly binding: DesktopCertificationBinding
  readonly environment: NodeJS.ProcessEnv
  readonly expectedBinaryPath: string
  readonly platform: CertifiedPlatform
  readonly processAdapter?: CertifiedProcessAdapter
}): Promise<CertifiedDaemonCleanup> {
  const marker = await readCertifiedDaemonMarker(input.binding.root)
  if (marker === undefined) return { markerPublished: false, processAbsent: false, terminated: false }
  const expectedBinaryPath = await realpath(input.expectedBinaryPath)
  assertDaemonBinding(marker, input.binding, expectedBinaryPath, input.platform)
  const identityEvidence = {
    binaryPathSha256: createHash("sha256").update(marker.daemon.binaryPath).digest("hex"),
    pid: marker.daemon.pid,
    startedAtUnixMillis: marker.daemon.startedAtUnixMillis,
    startTokenSha256: createHash("sha256").update(marker.daemon.startToken).digest("hex"),
  }
  const adapter = input.processAdapter ?? defaultProcessAdapter(
    input.platform,
    input.environment,
    marker.daemon.startToken,
  )
  const existing = await adapter.inspect(marker.daemon.pid)
  if (existing === undefined) {
    return { ...identityEvidence, markerPublished: true, processAbsent: true, terminated: false }
  }
  assertOwnedProcess(existing, marker, input.platform)
  await adapter.terminate(marker.daemon.pid, false)
  if (await waitForAbsence(adapter, marker, input.platform, 2_000)) {
    return { ...identityEvidence, markerPublished: true, processAbsent: true, terminated: true }
  }
  const remaining = await adapter.inspect(marker.daemon.pid)
  if (remaining !== undefined) assertOwnedProcess(remaining, marker, input.platform)
  await adapter.terminate(marker.daemon.pid, true)
  if (!await waitForAbsence(adapter, marker, input.platform, 3_000)) {
    throw new Error("Certified workflowd did not exit during Desktop cleanup")
  }
  return { ...identityEvidence, markerPublished: true, processAbsent: true, terminated: true }
}

async function readCertifiedDaemonMarker(root: string): Promise<DesktopDaemonMarker | undefined> {
  const path = join(root, "desktop-daemon.json")
  const file = await readVerifiedRegularFile(path, { maxBytes: 64 * 1024, root }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  if (file === undefined) return undefined
  return parseDesktopDaemonMarker(JSON.parse(file.content.toString("utf8")) as unknown)
}

function assertDaemonBinding(
  marker: DesktopDaemonMarker,
  binding: DesktopCertificationBinding,
  expectedBinaryPath: string,
  platform: CertifiedPlatform,
): void {
  if (
    marker.nonce !== binding.nonce ||
    marker.revision !== binding.revision ||
    marker.pluginPackageSha256 !== binding.pluginPackageSha256 ||
    marker.nativePackageSha256 !== binding.nativePackageSha256 ||
    marker.runDigest !== desktopCertificationBindingDigest(binding) ||
    marker.daemon.startToken !== desktopCertificationProcessToken(binding) ||
    marker.daemon.startedAtUnixMillis < binding.startedAtUnixMillis ||
    normalizeForPlatform(marker.daemon.binaryPath, platform) !==
      normalizeForPlatform(expectedBinaryPath, platform)
  ) {
    throw new Error("Desktop daemon marker does not match the certification run")
  }
}

function assertOwnedProcess(
  snapshot: CertifiedProcessSnapshot,
  marker: DesktopDaemonMarker,
  platform: CertifiedPlatform,
): void {
  if (
    snapshot.pid !== marker.daemon.pid ||
    !snapshot.ownerTokenPresent ||
    normalizeForPlatform(snapshot.binaryPath, platform) !== normalizeForPlatform(marker.daemon.binaryPath, platform)
  ) {
    throw new Error("Desktop cleanup refused a non-matching workflowd process")
  }
}

async function waitForAbsence(
  adapter: CertifiedProcessAdapter,
  marker: DesktopDaemonMarker,
  platform: CertifiedPlatform,
  timeout: number,
): Promise<boolean> {
  const attempts = Math.ceil(timeout / 50)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await adapter.inspect(marker.daemon.pid)
    if (snapshot === undefined) return true
    assertOwnedProcess(snapshot, marker, platform)
    await adapter.sleep(50)
  }
  return false
}

function defaultProcessAdapter(
  platform: CertifiedPlatform,
  environment: NodeJS.ProcessEnv,
  ownerToken: string,
): CertifiedProcessAdapter {
  if (platform === "windows-x64") return windowsProcessAdapter(environment, ownerToken)
  return linuxProcessAdapter(ownerToken)
}

function windowsProcessAdapter(
  environment: NodeJS.ProcessEnv,
  ownerToken: string,
): CertifiedProcessAdapter {
  const systemRoot = environment.SystemRoot
  if (!systemRoot) throw new Error("Certified Windows daemon cleanup requires SystemRoot")
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const taskkill = win32.join(systemRoot, "System32", "taskkill.exe")
  const commandEnvironment = {
    ...environment,
    PSModulePath: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  }
  return {
    async inspect(pid) {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
        "if ($null -eq $p) { Write-Output '{\"exists\":false}'; exit 0 }",
        "$v = [ordered]@{ exists = $true; path = [string]$p.ExecutablePath; command = [string]$p.CommandLine }",
        "$v | ConvertTo-Json -Compress",
      ].join("; ")
      const output = await boundedCommand([powershell, "-NoProfile", "-NonInteractive", "-Command", script], commandEnvironment)
      const value = JSON.parse(output) as { command?: unknown; exists?: unknown; path?: unknown }
      if (value.exists === false) return undefined
      if (value.exists !== true || typeof value.path !== "string" || typeof value.command !== "string") {
        throw new Error("Certified Windows process inspection returned malformed data")
      }
      return {
        binaryPath: value.path,
        ownerTokenPresent: commandContainsOwnerToken(value.command, ownerToken),
        pid,
      }
    },
    sleep: Bun.sleep,
    async terminate(pid, force) {
      await boundedCommand(
        [taskkill, "/T", ...(force ? ["/F"] : []), "/PID", String(pid)],
        commandEnvironment,
        true,
      )
    },
  }
}

function linuxProcessAdapter(ownerToken: string): CertifiedProcessAdapter {
  return {
    async inspect(pid) {
      const root = `/proc/${pid}`
      const command = await readFile(join(root, "cmdline")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (command === undefined) return undefined
      const binaryPath = await realpath(join(root, "exe"))
      const argumentsList = command.toString("utf8").split("\0").filter(Boolean)
      const ownerIndex = argumentsList.indexOf("--certification-owner-token")
      return {
        binaryPath,
        ownerTokenPresent: ownerIndex >= 0 && argumentsList[ownerIndex + 1] === ownerToken,
        pid,
      }
    },
    sleep: Bun.sleep,
    async terminate(pid, force) {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    },
  }
}

async function boundedCommand(
  command: readonly string[],
  environment: NodeJS.ProcessEnv,
  allowNonzero = false,
): Promise<string> {
  const child = Bun.spawn([...command], { env: environment, stderr: "ignore", stdout: "pipe" })
  const output = Buffer.from(await new Response(child.stdout).arrayBuffer())
  const exitCode = await child.exited
  if (output.length > 64 * 1024) throw new Error("Certified process command output exceeded its bound")
  if (exitCode !== 0 && !allowNonzero) throw new Error("Certified process command failed")
  return output.toString("utf8").trim()
}

function commandContainsOwnerToken(command: string, ownerToken: string): boolean {
  const pattern = new RegExp(`(?:^|\\s)--certification-owner-token(?:\\s+|=)\"?${ownerToken}\"?(?:\\s|$)`, "u")
  return pattern.test(command)
}

function normalizeForPlatform(path: string, platform: CertifiedPlatform): string {
  const value = normalize(path)
  return platform === "windows-x64" ? value.toLowerCase() : value
}
