import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  CERTIFIED_HOST_VERSIONS,
  CERTIFIED_PLATFORM_TARGETS,
  COMPATIBLE_PLATFORM_TARGETS,
  MINIMUM_HOST_VERSION,
  negotiateCapabilities,
  parseHostVersion,
  platformCompatibility,
} from "../src/capabilities.js"

const supportedClient = () => ({
  app: { agents() {}, log() {} },
  config: { providers() {} },
  session: { abort() {}, children() {}, create() {}, prompt() {}, promptAsync() {} },
})

test("reports macOS as compatible but untested and never as certified", () => {
  expect(CERTIFIED_PLATFORM_TARGETS).toEqual(["linux-x64", "win32-x64"])
  expect(COMPATIBLE_PLATFORM_TARGETS).toEqual(["darwin-arm64", "darwin-x64"])

  for (const [platform, architecture] of [["darwin", "x64"], ["darwin", "arm64"]] as const) {
    const compatibility = platformCompatibility(platform, architecture)
    expect(compatibility.supported).toBeTrue()
    expect(compatibility.certified).toBeFalse()
    expect(compatibility.message).toContain("compatible but untested")

    // The product still runs; it simply must not claim certification.
    const result = negotiateCapabilities(supportedClient(), "1.18.21", platform, architecture)
    expect(result.safeMode).toBeFalse()
    expect(result.reasons).toEqual([])
    expect(result.certified).toBeFalse()
    expect(result.platform.certified).toBeFalse()
    expect(result.warnings.join(" ")).toContain("compatible but untested")
  }

  for (const [platform, architecture] of [["linux", "x64"], ["win32", "x64"]] as const) {
    const result = negotiateCapabilities(supportedClient(), "1.18.21", platform, architecture)
    expect(result.certified).toBeTrue()
    expect(result.platform.certified).toBeTrue()
    expect(result.warnings).toEqual([])
  }

  const unsupported = negotiateCapabilities(supportedClient(), "1.18.21", "freebsd", "x64")
  expect(unsupported.platform.supported).toBeFalse()
  expect(unsupported.safeMode).toBeTrue()
  expect(unsupported.reasons).toContain("Unsupported platform")
})

test("enables certified hosts without safe mode", () => {
  // Certification follows the evidence: 1.18.21 is the only host with a
  // Desktop receipt on the released revision.
  expect(CERTIFIED_HOST_VERSIONS).toEqual(["1.18.21"])
  // The compatibility floor is unchanged, so hosts from 1.18.16 upward keep
  // running; they are simply no longer presented as certified.
  expect(MINIMUM_HOST_VERSION).toBe("1.18.16")
  for (const version of CERTIFIED_HOST_VERSIONS) {
    const result = negotiateCapabilities(supportedClient(), version, "win32", "x64")
    expect(result.safeMode).toBeFalse()
    expect(result.certified).toBeTrue()
    expect(result.host.certified).toBeTrue()
    expect(result.capabilities).toEqual([
      "agent-list",
      "async-prompt",
      "child-sessions",
      "configuration",
      "logging",
      "prompt",
      "session-abort",
      "session-create",
    ])
  }
})

test("other 1.x Desktop versions stay active but are never reported certified", () => {
  // 1.18.16 and 1.18.18 carried certification claims before 1.18.21 was
  // proven. They keep working and must now report as compatible only, so no
  // stale claim outlives its evidence.
  for (const version of ["1.18.16", "1.18.17", "1.18.18", "1.18.19", "1.18.20", "1.19.0"]) {
    const result = negotiateCapabilities(supportedClient(), version)
    expect(result.safeMode).toBeFalse()
    expect(result.certified).toBeFalse()
    expect(result.host.compatible).toBeTrue()
    expect(result.warnings.join(" ")).toContain(version)
    expect(result.reasons).toEqual([])
  }
})

test("a future major says what is wrong and what is needed, without echoing the host", () => {
  for (const version of ["2.0.0", "2.1.4", "3.0.0"]) {
    const result = negotiateCapabilities(supportedClient(), version)

    // The plugin API changed with the major version, so this build cannot run
    // here. Saying only "did not start" leaves the user guessing at a bug.
    expect(result.safeMode).toBeTrue()
    expect(result.host.compatible).toBeFalse()
    expect(result.host.message).toContain("plugin API")
    expect(result.host.message).toContain("Cycle did not start")

    const reasons = result.reasons.join(" ")
    expect(reasons).toContain("plugin API")
    expect(reasons).toContain("build that targets it")

    // A host-supplied version string must never be echoed into the reasons,
    // which reach an agent template.
    expect(reasons).not.toContain(version)
  }
})

test("supported 1.x hosts never enter safe mode, however far ahead", () => {
  // A newer 1.x must keep working: the contract is the major version, not a
  // list someone has to remember to extend.
  for (const version of ["1.18.16", "1.18.21", "1.19.0", "1.30.7", "1.999.999"]) {
    const result = negotiateCapabilities(supportedClient(), version, "win32", "x64")
    expect(result.safeMode, version).toBeFalse()
    expect(result.host.compatible, version).toBeTrue()
    expect(result.reasons, version).toEqual([])
  }
})

test("pins the OpenCode plugin and SDK dependency graph to the certified Desktop release", async () => {
  const root = resolve(import.meta.dir, "../../..")
  for (const manifestPath of [
    resolve(root, "package.json"),
    resolve(root, "packages", "opencode-cycle", "package.json"),
  ]) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.["@opencode-ai/plugin"]).toBe("1.18.21")
    expect(manifest.dependencies?.["@opencode-ai/sdk"]).toBe("1.18.21")
  }
})

test("missing host version stays active when required capabilities exist", () => {
  const result = negotiateCapabilities(supportedClient())
  expect(result.safeMode).toBeFalse()
  expect(result.certified).toBeFalse()
  expect(result.host.compatible).toBeTrue()
  expect(result.warnings.length).toBeGreaterThan(0)
})

test("missing required capability enters safe mode", () => {
  const client = supportedClient()
  delete (client.session as Partial<typeof client.session>).children
  const result = negotiateCapabilities(client, "1.18.16")
  expect(result.safeMode).toBeTrue()
  expect(result.reasons).toContain("Missing required capability: child-sessions")
})

test("unreadable or other-major hosts enter safe mode without echoing the version in reasons", () => {
  for (const version of [
    "1.18.16+certified",
    "1.18.18-rc.1",
    "1.18.18+build.1",
    "1.18.18.",
    "1.18.18.untrusted",
    "1.18.16.999",
    "2.0.0",
  ]) {
    const result = negotiateCapabilities(supportedClient(), version)
    expect(result.safeMode).toBeTrue()
    expect(result.host.compatible).toBeFalse()
    // The reason must identify the host as the problem. An unreadable version
    // and an incompatible major are different faults and are worded
    // differently; both must still say which one it is.
    expect(result.reasons.some((reason) =>
      reason.includes("host version") || reason.includes("plugin API"))).toBeTrue()
    expect(result.reasons.join(" ")).not.toContain(version)
  }
})

test("hosts below the minimum enter safe mode", () => {
  const result = negotiateCapabilities(supportedClient(), "1.18.15")
  expect(result.safeMode).toBeTrue()
  expect(result.reasons).toContain("Unsupported OpenCode host version")
  expect(parseHostVersion("1.18.19")).toEqual({ major: 1, minor: 18, patch: 19 })
})
