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
  readonly reasons: readonly string[]
  readonly safeMode: boolean
  readonly warnings: readonly string[]
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

export const CERTIFIED_HOST_VERSIONS = ["1.18.16", "1.18.18"] as const
export const MINIMUM_HOST_VERSION = "1.18.16" as const
export const SUPPORTED_HOST_MAJOR = 1

const CERTIFIED_HOST_VERSION_SET = new Set<string>(CERTIFIED_HOST_VERSIONS)

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
): CapabilityReport {
  const capabilities = REQUIRED_CAPABILITIES.filter((capability) =>
    hasFunction(client, capabilityPaths[capability]),
  )
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability)).map(
    (capability) => `Missing required capability: ${capability}`,
  )
  const host = hostCompatibility(hostVersion)
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
  const warnings = host.compatible && !host.certified ? [host.message] : []

  return {
    capabilities,
    certified: host.certified && missing.length === 0,
    host,
    reasons,
    safeMode: reasons.length > 0,
    warnings,
  }
}

export function hostCommandNotice(report: CapabilityReport): string | undefined {
  if (report.safeMode || report.certified) return undefined
  return report.host.message
}
