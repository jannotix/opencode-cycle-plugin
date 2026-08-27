export type HostCapability =
  | "agent-list"
  | "async-prompt"
  | "child-sessions"
  | "configuration"
  | "logging"
  | "prompt"
  | "session-abort"
  | "session-create"

export interface CapabilityReport {
  readonly capabilities: readonly HostCapability[]
  readonly certified: boolean
  readonly host: HostCompatibility
  readonly platform: PlatformCompatibility
  readonly reasons: readonly string[]
  readonly safeMode: boolean
  readonly warnings: readonly string[]
}

export interface PlatformCompatibility {
  readonly certified: boolean
  readonly message: string
  readonly supported: boolean
  readonly target: string
}

export interface HostCompatibility {
  readonly certified: boolean
  readonly certifiedVersions: readonly string[]
  readonly compatible: boolean
  readonly message: string
  readonly minimumVersion: string
  readonly version: string | null
}

export interface ParsedHostVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const REQUIRED_CAPABILITIES: readonly HostCapability[] = [
  "agent-list",
  "async-prompt",
  "child-sessions",
  "configuration",
  "logging",
  "prompt",
  "session-abort",
  "session-create",
]

// Certification follows the evidence, never the other way round: only a host
// with a Desktop receipt on the released revision belongs here. 1.18.16 and
// 1.18.18 were certified against earlier revisions and are now compatible
// historical hosts, so the floor below stays where it is and they keep
// running without carrying a claim their evidence no longer supports.
export const CERTIFIED_HOST_VERSIONS = ["1.18.21"] as const
export const MINIMUM_HOST_VERSION = "1.18.16" as const
export const SUPPORTED_HOST_MAJOR = 1

// Desktop certification evidence exists for these targets only.
export const CERTIFIED_PLATFORM_TARGETS = ["linux-x64", "win32-x64"] as const
// These ship and run, with no Desktop certification claimed for them.
export const COMPATIBLE_PLATFORM_TARGETS = ["darwin-arm64", "darwin-x64"] as const

const CERTIFIED_HOST_VERSION_SET = new Set<string>(CERTIFIED_HOST_VERSIONS)
const CERTIFIED_PLATFORM_SET = new Set<string>(CERTIFIED_PLATFORM_TARGETS)
const COMPATIBLE_PLATFORM_SET = new Set<string>(COMPATIBLE_PLATFORM_TARGETS)

export function platformCompatibility(
  platform: NodeJS.Platform,
  architecture: string,
): PlatformCompatibility {
  const target = `${platform}-${architecture}`
  if (CERTIFIED_PLATFORM_SET.has(target)) {
    return {
      certified: true,
      message: `${target} is a certified platform.`,
      supported: true,
      target,
    }
  }
  if (COMPATIBLE_PLATFORM_SET.has(target)) {
    return {
      certified: false,
      message:
        `${target} is compatible but untested. Cycle runs and its packages are ` +
        `published for this platform, and no Desktop certification evidence covers it. ` +
        `Certified evidence covers ${CERTIFIED_PLATFORM_TARGETS.join(", ")}.`,
      supported: true,
      target,
    }
  }
  return {
    certified: false,
    message:
      `${target} is not a supported platform. Supported targets are ` +
      `${[...CERTIFIED_PLATFORM_TARGETS, ...COMPATIBLE_PLATFORM_TARGETS].join(", ")}.`,
    supported: false,
    target,
  }
}

const capabilityPaths: Readonly<Record<HostCapability, readonly string[]>> = {
  "agent-list": ["app", "agents"],
  "async-prompt": ["session", "promptAsync"],
  "child-sessions": ["session", "children"],
  configuration: ["config", "providers"],
  logging: ["app", "log"],
  prompt: ["session", "prompt"],
  "session-abort": ["session", "abort"],
  "session-create": ["session", "create"],
}

function hasFunction(root: unknown, path: readonly string[]): boolean {
  let value = root
  for (const segment of path) {
    if (typeof value !== "object" || value === null) return false
    value = (value as Record<string, unknown>)[segment]
  }
  return typeof value === "function"
}

export function parseHostVersion(version: string): ParsedHostVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareHostVersion(left: ParsedHostVersion, right: ParsedHostVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

const MINIMUM_PARSED = parseHostVersion(MINIMUM_HOST_VERSION)

export function hostCompatibility(version: string | undefined): HostCompatibility {
  const certifiedVersions = CERTIFIED_HOST_VERSIONS
  if (version === undefined) {
    return {
      certified: false,
      certifiedVersions,
      compatible: true,
      message: `OpenCode host version was not reported. Required plugin capabilities are present, so Cycle continues. Certified evidence covers ${certifiedVersions.join(", ")}.`,
      minimumVersion: MINIMUM_HOST_VERSION,
      version: null,
    }
  }
  const parsed = parseHostVersion(version)
  if (parsed === undefined) {
    return {
      certified: false,
      certifiedVersions,
      compatible: false,
      message: "OpenCode host version is unreadable. Restore a certified Desktop build.",
      minimumVersion: MINIMUM_HOST_VERSION,
      version,
    }
  }
  if (parsed.major !== SUPPORTED_HOST_MAJOR) {
    return {
      certified: false,
      certifiedVersions,
      compatible: false,
      message: `OpenCode ${version} is outside major version ${SUPPORTED_HOST_MAJOR}. Cycle did not start.`,
      minimumVersion: MINIMUM_HOST_VERSION,
      version,
    }
  }
  if (MINIMUM_PARSED !== undefined && compareHostVersion(parsed, MINIMUM_PARSED) < 0) {
    return {
      certified: false,
      certifiedVersions,
      compatible: false,
      message: `OpenCode ${version} is below the minimum ${MINIMUM_HOST_VERSION}. Cycle did not start.`,
      minimumVersion: MINIMUM_HOST_VERSION,
      version,
    }
  }
  const certified = CERTIFIED_HOST_VERSION_SET.has(version)
  return {
    certified,
    certifiedVersions,
    compatible: true,
    message: certified
      ? `OpenCode ${version} is a certified host.`
      : `OpenCode ${version} matches the 1.x plugin contract and is above ${MINIMUM_HOST_VERSION}. Release evidence covers ${certifiedVersions.join(", ")}. Cycle continues; this host is not in the certified evidence set.`,
    minimumVersion: MINIMUM_HOST_VERSION,
    version,
  }
}

export function negotiateCapabilities(
  client: unknown,
  hostVersion?: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): CapabilityReport {
  const capabilities = REQUIRED_CAPABILITIES.filter((capability) =>
    hasFunction(client, capabilityPaths[capability]),
  )
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability)).map(
    (capability) => `Missing required capability: ${capability}`,
  )
  const host = hostCompatibility(hostVersion)
  const platformCompatibilityReport = platformCompatibility(platform, architecture)
  const reasons = [...missing]
  if (!host.compatible) {
    reasons.push(
      host.version === null
        ? "OpenCode host version is unavailable"
        : parseHostVersion(host.version) === undefined
          ? "OpenCode host version is unreadable"
          : "Unsupported OpenCode host version",
    )
  }
  if (!platformCompatibilityReport.supported) {
    reasons.push("Unsupported platform")
  }
  const warnings = [
    ...(host.compatible && !host.certified ? [host.message] : []),
    ...(platformCompatibilityReport.supported && !platformCompatibilityReport.certified
      ? [platformCompatibilityReport.message]
      : []),
  ]

  return {
    capabilities,
    // A certified claim requires a certified host *and* a certified platform:
    // an untested platform must never be reported as certified.
    certified: host.certified && platformCompatibilityReport.certified && missing.length === 0,
    host,
    platform: platformCompatibilityReport,
    reasons,
    safeMode: reasons.length > 0,
    warnings,
  }
}

export function hostCommandNotice(report: CapabilityReport): string | undefined {
  if (report.safeMode || report.certified) return undefined
  return report.host.message
}
