import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  activationScanRoots,
  certificationEnvironment,
  isDesktopHarnessPath,
  desktopTestProfiles,
  desktopTestProfileRoots,
  fetchDesktopAsset,
  parseWindowsProtocolRegistration,
  stageDesktopAsset,
  terminateDesktopProcess,
  validateDesktopAsset,
  windowsDesktopExtraction,
  windowsPowerShellEnvironment,
  windowsPowerShellPath,
  SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS,
  type DesktopAsset,
} from "./desktop-certification.js"

test("Desktop certification exposes only Windows x64 and Linux x64 for v1", () => {
  expect(SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS).toEqual(["linux-x64", "windows-x64"])
  expect(SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS).not.toContain("macos-x64")
})

test("Desktop cleanup terminates the complete Unix process group", async () => {
  if (process.platform === "win32") return
  const platform = "linux-x64"
  const child = Bun.spawn(["sh", "-c", "sleep 30 & wait"], {
    detached: true,
    stderr: "ignore",
    stdout: "ignore",
  })
  await Bun.sleep(100)

  await terminateDesktopProcess(child, platform)

  expect(() => process.kill(-child.pid, 0)).toThrow()
})

const asset: DesktopAsset = {
  name: "opencode-desktop-win-x64.exe",
  sha256: "a".repeat(64),
  size: 123,
  url: "https://github.com/anomalyco/opencode/releases/download/v1.18.16/opencode-desktop-win-x64.exe",
}

test("desktop asset policy accepts only immutable official release assets", () => {
  expect(() => validateDesktopAsset("windows-x64", asset, "1.18.16")).not.toThrow()
  expect(() =>
    validateDesktopAsset("windows-x64", { ...asset, url: "https://example.invalid/file" }, "1.18.16"),
  ).toThrow("official release")
  expect(() => validateDesktopAsset("windows-x64", { ...asset, sha256: "bad" }, "1.18.16")).toThrow(
    "SHA-256",
  )
})

test("certification uses an isolated Desktop and OpenCode profile", () => {
  const root = join(tmpdir(), "certification")
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64"
  const environment = certificationEnvironment(root, platform, {
    PATH: "safe-path",
  })

  expect(environment.APPDATA).toBe(join(root, "appdata"))
  expect(environment.LOCALAPPDATA).toBe(join(root, "localappdata"))
  expect(environment.XDG_CONFIG_HOME).toBe(join(root, "xdg", "config"))
  expect(environment.USERPROFILE).toBe(join(root, "home"))
  expect(environment.PATH).toBe("safe-path")
  expect(environment.OPENCODE_DISABLE_AUTOUPDATE).toBe("true")
  expect(environment.OPENCODE_TEST_ONBOARDING).toBe("1")
})

test("certification scratch directories are not treated as Desktop test profiles", () => {
  const scratch = join(tmpdir(), "opencode-cycle-desktop-certification-scratch")
  expect(isDesktopHarnessPath(scratch, scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(scratch, "home"), scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(scratch, "project"), scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(tmpdir(), "opencode-onboarding-certified"), scratch)).toBe(false)
})

test("activation scan includes the isolated default Cycle data directory", () => {
  const root = join(tmpdir(), "certification")
  const environment = certificationEnvironment(root, "windows-x64", { PATH: "safe-path" })
  const roots = activationScanRoots(join(root, "workflow-data"), join(root, "profile"), environment)
  expect(roots).toContain(join(root, "localappdata", "OpenCode Cycle"))
  expect(roots).toContain(join(root, "xdg", "data", "opencode-cycle"))
})

test("Desktop test profile discovery resolves valid profile directories recursively", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "opencode-cycle-profile-test-"))
  const expected = join(temporary, "opencode-onboarding-certified")
  const expectedSettings = join(expected, "desktop", "opencode.settings")
  try {
    await mkdir(join(expected, "desktop"), { recursive: true })
    await writeFile(expectedSettings, "{}")
    await Promise.all([
      mkdir(join(temporary, "unrelated")),
      mkdir(join(temporary, "nested", "opencode-onboarding-ignored"), { recursive: true }),
    ])
    await expect(desktopTestProfiles([temporary])).resolves.toEqual(new Set([expected]))
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})

test("desktop profile discovery scans certification roots", () => {
  const roots = {
    APPDATA: "C:\\appdata",
    HOME: "C:\\home",
    XDG_CONFIG_HOME: "C:\\config",
    XDG_DATA_HOME: "C:\\data",
    XDG_STATE_HOME: "C:\\state",
    LOCALAPPDATA: "C:\\local",
  }
  const discovered = desktopTestProfileRoots(roots)
  expect(discovered).toEqual([
    tmpdir(),
    "/tmp",
    "/var/tmp",
    "C:\\home",
    "C:\\config",
    "C:\\data",
    "C:\\state",
    "C:\\local",
    "C:\\appdata",
  ])
})

test("Windows signature verification uses the system PowerShell module host", () => {
  expect(windowsPowerShellPath({ SystemRoot: "C:\\Windows" })).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  )
  expect(() => windowsPowerShellPath({})).toThrow("SystemRoot")
  expect(windowsPowerShellEnvironment({ SystemRoot: "C:\\Windows" }).PSModulePath).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
  )
})

test("Windows protocol snapshots fail closed and preserve exact commands", () => {
  expect(
    parseWindowsProtocolRegistration(
      '{"existed":true,"command":"\\\"C:\\\\Program Files\\\\OpenCode\\\\OpenCode.exe\\\" \\\"%1\\\""}',
    ),
  ).toEqual({
    command: '"C:\\Program Files\\OpenCode\\OpenCode.exe" "%1"',
    existed: true,
  })
  expect(parseWindowsProtocolRegistration('{"existed":false}')).toEqual({ existed: false })
  expect(() => parseWindowsProtocolRegistration('{"existed":true}')).toThrow("command is missing")
})

test("Desktop download retries a reset connection and verifies exact bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opencode-cycle-download-test-"))
  const bytes = Buffer.from("certified desktop")
  let attempts = 0
  try {
    await fetchDesktopAsset(
      {
        name: "fixture",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        url: "https://example.invalid/fixture",
      },
      join(temporary, "fixture"),
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error("connection reset")
        return new Response(bytes)
      },
      0,
    )
    expect(attempts).toBe(2)
    expect(await readFile(join(temporary, "fixture"))).toEqual(bytes)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})

test("local Desktop assets are staged only after exact byte verification", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "opencode-cycle-local-asset-test-"))
  const bytes = Buffer.from("certified local desktop")
  const source = join(temporary, "source")
  const destination = join(temporary, "destination")
  try {
    await writeFile(source, bytes)
    await stageDesktopAsset(
      {
        ...asset,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      },
      destination,
      source,
    )
    expect(await readFile(destination)).toEqual(bytes)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})

test("Windows Desktop extraction is non-installing and contained in certification scratch", () => {
  expect(
    windowsDesktopExtraction("C:\\asset.exe", "C:\\scratch", {
      ProgramFiles: "C:\\Program Files",
    }),
  ).toEqual({
    commands: [
      [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "x",
        "C:\\asset.exe",
        "-oC:\\scratch\\nsis",
        "-y",
        "-ir!$PLUGINSDIR\\app-64.7z",
      ],
      [
        "C:\\Program Files\\7-Zip\\7z.exe",
        "x",
        "C:\\scratch\\nsis\\$PLUGINSDIR\\app-64.7z",
        "-oC:\\scratch\\desktop",
        "-y",
      ],
    ],
    executable: "C:\\scratch\\desktop\\OpenCode.exe",
    extractor: "C:\\Program Files\\7-Zip\\7z.exe",
  })
})
