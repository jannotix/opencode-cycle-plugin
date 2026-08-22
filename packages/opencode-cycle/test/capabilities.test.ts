import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  CERTIFIED_HOST_VERSIONS,
  MINIMUM_HOST_VERSION,
  negotiateCapabilities,
  parseHostVersion,
} from "../src/capabilities.js"

const supportedClient = () => ({
  app: { agents() {}, log() {} },
  config: { providers() {} },
  session: { abort() {}, children() {}, create() {}, prompt() {}, promptAsync() {} },
})

test("enables certified hosts without safe mode", () => {
  expect(CERTIFIED_HOST_VERSIONS).toEqual(["1.18.16", "1.18.18"])
  expect(MINIMUM_HOST_VERSION).toBe("1.18.16")
  for (const version of CERTIFIED_HOST_VERSIONS) {
    const result = negotiateCapabilities(supportedClient(), version)
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

test("newer 1.x Desktop updates stay active when required capabilities exist", () => {
  for (const version of ["1.18.17", "1.18.19", "1.18.20", "1.18.21", "1.19.0"]) {
    const result = negotiateCapabilities(supportedClient(), version)
    expect(result.safeMode).toBeFalse()
    expect(result.certified).toBeFalse()
    expect(result.host.compatible).toBeTrue()
    expect(result.warnings.join(" ")).toContain(version)
    expect(result.reasons).toEqual([])
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
    expect(result.reasons.some((reason) => reason.includes("host version"))).toBeTrue()
    expect(result.reasons.join(" ")).not.toContain(version)
  }
})

test("hosts below the minimum enter safe mode", () => {
  const result = negotiateCapabilities(supportedClient(), "1.18.15")
  expect(result.safeMode).toBeTrue()
  expect(result.reasons).toContain("Unsupported OpenCode host version")
  expect(parseHostVersion("1.18.19")).toEqual({ major: 1, minor: 18, patch: 19 })
})
