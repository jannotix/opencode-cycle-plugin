import { open, lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import type { ControlPlaneHealth } from "./client.js"

const FULL_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const SHA256 = /^[0-9a-f]{64}$/u

export interface DesktopCertificationBinding {
  readonly nativePackageSha256: string
  readonly nonce: string
  readonly pluginPackageSha256: string
  readonly revision: string
  readonly root: string
  readonly startedAtUnixMillis: number
}

export interface DesktopActivationMarker {
  readonly createdAtUnixMillis: number
  readonly health: {
    readonly productVersion: "1.0.0"
    readonly protocolVersion: 1
    readonly schemaMode: "read_write"
    readonly schemaVersion: 17
  }
  readonly nativePackageSha256: string
  readonly nonce: string
  readonly pluginPackageSha256: string
  readonly revision: string
  readonly schemaVersion: 1
  readonly type: "opencode-cycle-desktop-activation"
}

export function certificationBindingFromOptions(
  options: unknown,
  environment: NodeJS.ProcessEnv,
): DesktopCertificationBinding | undefined {
  if (!isRecord(options) || options.certification === undefined) return undefined
  const value = requireExactRecord(
    options.certification,
    [
      "nativePackageSha256",
      "nonce",
      "pluginPackageSha256",
      "revision",
      "root",
      "startedAtUnixMillis",
    ],
    "Desktop certification binding",
  )
  if (typeof value.root !== "string" || !isAbsolute(value.root) || resolve(value.root) !== value.root) {
    throw new Error("Desktop certification root must be an absolute normalized path")
  }
  if (environment.CYCLE_CERTIFICATION_ROOT !== value.root) {
    throw new Error("Desktop certification root does not match the isolated environment")
  }
  if (typeof value.nonce !== "string" || !SHA256.test(value.nonce)) {
    throw new Error("Desktop certification nonce must be 32 unpredictable bytes")
  }
  if (environment.CYCLE_CERTIFICATION_NONCE !== value.nonce) {
    throw new Error("Desktop certification nonce does not match the isolated environment")
  }
  if (typeof value.revision !== "string" || !FULL_REVISION.test(value.revision)) {
    throw new Error("Desktop certification revision must be a full Git object ID")
  }
  for (const key of ["pluginPackageSha256", "nativePackageSha256"] as const) {
    if (typeof value[key] !== "string" || !SHA256.test(value[key])) {
      throw new Error(`Desktop certification ${key} is invalid`)
    }
  }
  if (
    typeof value.startedAtUnixMillis !== "number" ||
    !Number.isSafeInteger(value.startedAtUnixMillis) ||
    value.startedAtUnixMillis < 1
  ) {
    throw new Error("Desktop certification start time is invalid")
  }
  return value as unknown as DesktopCertificationBinding
}

export function buildDesktopActivationMarker(
  binding: DesktopCertificationBinding,
  health: ControlPlaneHealth,
  createdAtUnixMillis: number,
): DesktopActivationMarker {
  if (
    health.product_version !== "1.0.0" ||
    health.protocol_version !== 1 ||
    health.schema_mode !== "read_write" ||
    health.schema_version !== 17
  ) {
    throw new Error("Desktop certification health is not the candidate read-write control plane")
  }
  if (
    !Number.isSafeInteger(createdAtUnixMillis) ||
    createdAtUnixMillis < binding.startedAtUnixMillis
  ) {
    throw new Error("Desktop certification activation time predates the isolated run")
  }
  return {
    createdAtUnixMillis,
    health: {
      productVersion: "1.0.0",
      protocolVersion: 1,
      schemaMode: "read_write",
      schemaVersion: 17,
    },
    nativePackageSha256: binding.nativePackageSha256,
    nonce: binding.nonce,
    pluginPackageSha256: binding.pluginPackageSha256,
    revision: binding.revision,
    schemaVersion: 1,
    type: "opencode-cycle-desktop-activation",
  }
}

export function parseDesktopActivationMarker(value: unknown): DesktopActivationMarker {
  const marker = requireExactRecord(
    value,
    [
      "createdAtUnixMillis",
      "health",
      "nativePackageSha256",
      "nonce",
      "pluginPackageSha256",
      "revision",
      "schemaVersion",
      "type",
    ],
    "Desktop activation marker",
  )
  const health = requireExactRecord(
    marker.health,
    ["productVersion", "protocolVersion", "schemaMode", "schemaVersion"],
    "Desktop activation health",
  )
  if (
    marker.schemaVersion !== 1 ||
    marker.type !== "opencode-cycle-desktop-activation" ||
    typeof marker.createdAtUnixMillis !== "number" ||
    !Number.isSafeInteger(marker.createdAtUnixMillis) ||
    typeof marker.nonce !== "string" ||
    !SHA256.test(marker.nonce) ||
    typeof marker.revision !== "string" ||
    !FULL_REVISION.test(marker.revision) ||
    typeof marker.pluginPackageSha256 !== "string" ||
    !SHA256.test(marker.pluginPackageSha256) ||
    typeof marker.nativePackageSha256 !== "string" ||
    !SHA256.test(marker.nativePackageSha256) ||
    health.productVersion !== "1.0.0" ||
    health.protocolVersion !== 1 ||
    health.schemaMode !== "read_write" ||
    health.schemaVersion !== 17
  ) {
    throw new Error("Desktop activation marker is invalid")
  }
  return marker as unknown as DesktopActivationMarker
}

export async function writeDesktopActivationMarker(
  binding: DesktopCertificationBinding,
  health: ControlPlaneHealth,
  now: () => number = Date.now,
): Promise<DesktopActivationMarker> {
  const rootDetails = await lstat(binding.root)
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error("Desktop certification root must be a real directory")
  }
  if (await realpath(binding.root) !== binding.root) {
    throw new Error("Desktop certification root must not be a link or alias")
  }
  const marker = buildDesktopActivationMarker(binding, health, now())
  const path = join(binding.root, "desktop-activation.json")
  let handle
  try {
    handle = await open(path, "wx", 0o600)
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      const details = await lstat(path)
      if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
        throw new Error("Desktop certification activation marker already exists as an unsafe file")
      }
      if (await realpath(path) !== path) {
        throw new Error("Desktop certification activation marker already exists through an alias")
      }
      const existing = parseDesktopActivationMarker(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      )
      if (
        existing.createdAtUnixMillis < binding.startedAtUnixMillis ||
        existing.nonce !== marker.nonce ||
        existing.revision !== marker.revision ||
        existing.pluginPackageSha256 !== marker.pluginPackageSha256 ||
        existing.nativePackageSha256 !== marker.nativePackageSha256 ||
        JSON.stringify(existing.health) !== JSON.stringify(marker.health)
      ) {
        throw new Error("Desktop certification activation marker already exists with another binding")
      }
      return existing
    }
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  return marker
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unknown fields`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
