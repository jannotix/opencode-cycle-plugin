import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  buildDesktopActivationMarker,
  type DesktopCertificationBinding,
} from "../../packages/opencode-cycle/src/certification.js"
import {
  activationScanRoots,
  certificationEnvironment,
  desktopLoadDiagnosticSummary,
  isDesktopHarnessPath,
  desktopTestProfiles,
  desktopTestProfileRoots,
  fetchDesktopAsset,
  parseWindowsProtocolRegistration,
  prepareDesktopCertificationLoad,
  stageDesktopAsset,
  terminateDesktopProcess,
  validateDesktopAsset,
  validateDesktopAssetMatrix,
  waitForDesktopActivation,
  windowsDesktopExtraction,
  windowsPowerShellEnvironment,
  windowsPowerShellPath,
  SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS,
  type DesktopAsset,
  type DesktopAssetMatrix,
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
  url: "https://github.com/anomalyco/opencode/releases/download/v1.18.21/opencode-desktop-win-x64.exe",
}

test("desktop asset policy accepts only immutable official release assets", () => {
  expect(() => validateDesktopAsset("windows-x64", asset, "1.18.21")).not.toThrow()
  expect(() =>
    validateDesktopAsset("windows-x64", { ...asset, url: "https://example.invalid/file" }, "1.18.21"),
  ).toThrow("official release")
  expect(() => validateDesktopAsset("windows-x64", { ...asset, sha256: "bad" }, "1.18.21")).toThrow(
    "SHA-256",
  )
  expect(() =>
    validateDesktopAsset(
      "windows-x64",
      {
        ...asset,
        name: "opencode-desktop-linux-x86_64.AppImage",
        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.21/opencode-desktop-linux-x86_64.AppImage",
      },
      "1.18.21",
    ),
  ).toThrow("asset name")
})

test("Desktop asset matrix is the exact official OpenCode 1.18.21 Windows/Linux release", async () => {
  const matrix = JSON.parse(
    await readFile(resolve(import.meta.dir, "../../.github/opencode-desktop-assets.json"), "utf8"),
  ) as DesktopAssetMatrix
  expect(() => validateDesktopAssetMatrix(matrix)).not.toThrow()
  expect(matrix).toEqual({
    assets: {
      "linux-x64": {
        name: "opencode-desktop-linux-x86_64.AppImage",
        sha256: "fb384fc4f030aca8624d775b8757cafa39b5871fc0eddeecebb128f25ed649d8",
        size: 158_944_115,
        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.21/opencode-desktop-linux-x86_64.AppImage",
      },
      "windows-x64": {
        name: "opencode-desktop-win-x64.exe",
        sha256: "3bd1a81d8fcb377a6bda60a9abf8d412aca1c9c702218ddbbdf7c7b09deaa739",
        size: 126_209_592,
        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.21/opencode-desktop-win-x64.exe",
      },
    },
    release: "https://github.com/anomalyco/opencode/releases/tag/v1.18.21",
    version: "1.18.21",
  })
  expect(() =>
    validateDesktopAssetMatrix({
      ...matrix,
      assets: { ...matrix.assets, "macos-x64": asset } as never,
    }),
  ).toThrow("platform set")
})

test("certification uses platform-specific isolated Desktop profiles", () => {
  const root = join(tmpdir(), "certification")
  for (const platform of ["windows-x64", "linux-x64"] as const) {
    const environment = certificationEnvironment(root, platform, {
      OPENAI_API_KEY: "must-not-leak",
      OPENCODE_CONFIG: "C:\\private\\opencode.json",
      OPENCODE_MODEL: "private/model",
      PATH: "safe-path",
      SystemRoot: "C:\\Windows",
    })

    expect(environment.APPDATA).toBe(join(root, "appdata"))
    expect(environment.LOCALAPPDATA).toBe(join(root, "localappdata"))
    expect(environment.XDG_CONFIG_HOME).toBe(join(root, "xdg", "config"))
    expect(environment.USERPROFILE).toBe(join(root, "home"))
    expect(environment.PATH).toBe("safe-path")
    expect(environment.OPENCODE_CONFIG_DIR).toBe(join(root, "opencode-config"))
    expect(environment.OPENCODE_CONFIG).toBe(join(root, "opencode-config", "opencode.json"))
    expect(environment.OPENCODE_DISABLE_AUTOUPDATE).toBe("true")
    expect(environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
    expect(environment.OPENCODE_TEST_ONBOARDING).toBe(
      platform === "windows-x64" ? "1" : undefined,
    )
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.OPENCODE_CONFIG).not.toBe("C:\\private\\opencode.json")
    expect(environment.OPENCODE_MODEL).toBeUndefined()
  }
})

test("official 1.18.21 Desktop overrides cannot displace the staged certification config", () => {
  const root = resolve(tmpdir(), "cycle-cert-config-binding")
  const stagedConfig = join(root, "opencode-config")

  for (const platform of ["windows-x64", "linux-x64"] as const) {
    const environment = certificationEnvironment(root, platform, { PATH: "safe-path" })
    const desktopEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      // Official Desktop replaces these during Windows onboarding and may import
      // different values from the login shell on Linux before spawning its sidecar.
      HOME: join(root, "desktop-shell-home"),
      XDG_CONFIG_HOME: join(root, "desktop-profile", "config"),
    }
    // OpenCode 1.18.21 resolves its explicit config directory before falling
    // back to the XDG-derived global directory.
    const discovered = desktopEnvironment.OPENCODE_CONFIG_DIR ??
      join(desktopEnvironment.XDG_CONFIG_HOME as string, "opencode")

    expect(discovered).toBe(stagedConfig)
    expect(desktopEnvironment.OPENCODE_CONFIG).toBe(join(stagedConfig, "opencode.json"))
  }
})

async function createDesktopLoadFixture(candidateSource = `
export default async function CandidateFixture(input, options) {
  return {
    binaryPath: options.binaryPath,
    certificationRoot: options.certification.root,
    dataDirectory: options.dataDirectory,
    fixtureInput: input.fixture,
    hostVersion: options.hostVersion,
    optionKeys: Object.keys(options).sort(),
  }
}
`) {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-cert-desktop-load-"))
  const certificationRoot = join(temporary, "certification")
  const packedPlugin = join(temporary, "packed-plugin")
  const nativeExecutable = join(temporary, "input", "workflowd.exe")
  const dataDirectory = join(temporary, "workflow-data")
  await Promise.all([
    mkdir(certificationRoot),
    mkdir(join(packedPlugin, "dist"), { recursive: true }),
    mkdir(join(temporary, "input")),
  ])
  await Promise.all([
    writeFile(join(packedPlugin, "package.json"), `${JSON.stringify({ type: "module" })}\n`),
    writeFile(join(packedPlugin, "dist", "index.js"), candidateSource),
    writeFile(nativeExecutable, "native fixture"),
  ])
  const binding: DesktopCertificationBinding = {
    nativePackageSha256: "d".repeat(64),
    nonce: "b".repeat(64),
    pluginPackageSha256: "c".repeat(64),
    revision: "a".repeat(40),
    root: certificationRoot,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  const environment = certificationEnvironment(
    temporary,
    "windows-x64",
    { PATH: "safe-path" },
    binding,
  )
  const prepared = await prepareDesktopCertificationLoad({
    certification: binding,
    dataDirectory,
    environment: {
      ...environment,
      HOME: join(temporary, "desktop-shell-home"),
      XDG_CONFIG_HOME: join(temporary, "desktop-profile", "config"),
    },
    hostVersion: "1.18.21",
    nativeExecutable,
    packedPlugin,
    platform: "windows-x64",
    scratch: temporary,
  })
  return { binding, dataDirectory, nativeExecutable, prepared, temporary }
}

test("bound Desktop config resolves and executes the candidate from the copied package layout", async () => {
  const fixture = await createDesktopLoadFixture()
  try {
    const config = JSON.parse(await readFile(fixture.prepared.configFile, "utf8")) as {
      $schema: string
      plugin: string[]
    }
    expect(config).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        pathToFileURL(fixture.prepared.configProbe).href,
        pathToFileURL(fixture.prepared.pluginLoader).href,
      ],
    })

    const probe = await import(`${pathToFileURL(fixture.prepared.configProbe).href}?success-probe`)
    expect(await probe.default({})).toEqual({})
    const candidate = await import(`${pathToFileURL(fixture.prepared.pluginLoader).href}?success-candidate`)
    const hooks = await candidate.default({ fixture: "real-entry" })
    expect(hooks).toEqual({
      binaryPath: join(fixture.prepared.installedPlugin, "bin", "workflowd.exe"),
      certificationRoot: fixture.binding.root,
      dataDirectory: fixture.dataDirectory,
      fixtureInput: "real-entry",
      hostVersion: "1.18.21",
      optionKeys: ["binaryPath", "certification", "dataDirectory", "hostVersion"],
    })
    expect(await desktopLoadDiagnosticSummary(fixture.binding.root)).toBe(
      "certification_env_binding=passed, config_tree_preparation=passed, " +
      "config_path_discovery=passed, plugin_specifier_resolution=passed, " +
      "candidate_module_resolution=passed, plugin_entry_execution=passed",
    )
    const diagnostics = await readFile(fixture.prepared.diagnosticsFile, "utf8")
    expect(diagnostics).not.toContain(fixture.temporary)
    expect(diagnostics).not.toContain(fixture.binding.nonce)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("Desktop load diagnostics fail closed at candidate module resolution without leaking details", async () => {
  const fixture = await createDesktopLoadFixture()
  try {
    const probe = await import(`${pathToFileURL(fixture.prepared.configProbe).href}?failure-probe`)
    await probe.default({})
    await rm(join(fixture.prepared.installedPlugin, "dist", "index.js"))

    await expect(
      import(`${pathToFileURL(fixture.prepared.pluginLoader).href}?missing-candidate`),
    ).rejects.toThrow("Cycle candidate module resolution failed")
    const summary = await desktopLoadDiagnosticSummary(fixture.binding.root)
    expect(summary).toContain("config_path_discovery=passed")
    expect(summary).toContain("plugin_specifier_resolution=passed")
    expect(summary).toContain("candidate_module_resolution=failed")
    expect(summary).toContain("plugin_entry_execution=missing")
    const diagnostics = await readFile(fixture.prepared.diagnosticsFile, "utf8")
    expect(diagnostics).not.toContain(fixture.temporary)
    expect(diagnostics).not.toContain(fixture.binding.nonce)

    let clock = fixture.binding.startedAtUnixMillis
    await expect(
      waitForDesktopActivation(fixture.binding.root, fixture.binding, 1, {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds
        },
      }),
    ).rejects.toThrow("candidate_module_resolution=failed")
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("Desktop load diagnostics isolate candidate entry failure without recording its message", async () => {
  const privateFailure = "private provider and model fixture must not enter diagnostics"
  const fixture = await createDesktopLoadFixture(`
export default async function CandidateFixture() {
  throw new Error(${JSON.stringify(privateFailure)})
}
`)
  try {
    const probe = await import(`${pathToFileURL(fixture.prepared.configProbe).href}?entry-failure-probe`)
    await probe.default({})
    const candidate = await import(
      `${pathToFileURL(fixture.prepared.pluginLoader).href}?entry-failure-candidate`
    )
    await expect(candidate.default({ fixture: "entry-failure" })).rejects.toThrow(privateFailure)

    const summary = await desktopLoadDiagnosticSummary(fixture.binding.root)
    expect(summary).toContain("candidate_module_resolution=passed")
    expect(summary).toContain("plugin_entry_execution=failed")
    const diagnostics = await readFile(fixture.prepared.diagnosticsFile, "utf8")
    expect(diagnostics).not.toContain(privateFailure)
    expect(diagnostics).not.toContain(fixture.temporary)
    expect(diagnostics).not.toContain(fixture.binding.nonce)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("malformed Desktop load diagnostics fail closed without echoing untrusted fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-invalid-load-diagnostic-"))
  const privateDetail = "private provider and model detail"
  const binding: DesktopCertificationBinding = {
    nativePackageSha256: "d".repeat(64),
    nonce: "b".repeat(64),
    pluginPackageSha256: "c".repeat(64),
    revision: "a".repeat(40),
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  try {
    await writeFile(
      join(root, "desktop-load-diagnostics.jsonl"),
      `${JSON.stringify({
        detail: privateDetail,
        schemaVersion: 1,
        stage: "plugin_entry_execution",
        status: "failed",
        type: "opencode-cycle-desktop-load-diagnostic",
      })}\n`,
    )
    await expect(desktopLoadDiagnosticSummary(root)).rejects.toThrow("malformed")

    let clock = binding.startedAtUnixMillis
    let failure: unknown
    try {
      await waitForDesktopActivation(root, binding, 1, {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("Desktop load diagnostics: invalid")
    expect((failure as Error).message).not.toContain(privateDetail)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("certification scratch directories are not treated as Desktop test profiles", () => {
  const scratch = join(tmpdir(), "opencode-cycle-desktop-certification-scratch")
  expect(isDesktopHarnessPath(scratch, scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(scratch, "home"), scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(scratch, "project"), scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(tmpdir(), "opencode-onboarding-certified"), scratch)).toBe(false)
})

test("activation evidence is confined to one freshly created certification root", () => {
  const root = join(tmpdir(), "certification")
  const environment = certificationEnvironment(root, "windows-x64", { PATH: "safe-path" })
  const roots = activationScanRoots(join(root, "workflow-data"), join(root, "profile"), environment)
  expect(roots).toEqual([join(root, "workflow-data")])
  expect(roots.join(" ")).not.toContain(process.env.HOME ?? "owner-home-not-set")
  expect(roots).not.toContain(join("/root", ".local", "share", "opencode-cycle"))
})

test("stale owner markers cannot satisfy the fresh certification root", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-cert-stale-owner-"))
  const root = join(temporary, "certification")
  const owner = join(temporary, "owner-home")
  const binding: DesktopCertificationBinding = {
    nativePackageSha256: "d".repeat(64),
    nonce: "b".repeat(64),
    pluginPackageSha256: "c".repeat(64),
    revision: "a".repeat(40),
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  let clock = binding.startedAtUnixMillis
  try {
    await Promise.all([mkdir(root), mkdir(owner)])
    const stale = buildDesktopActivationMarker(binding, {
      product_version: "1.0.0",
      protocol_version: 1,
      schema_mode: "read_write",
      schema_version: 17,
    }, clock)
    await writeFile(join(owner, "desktop-activation.json"), JSON.stringify(stale))
    await expect(
      waitForDesktopActivation(root, binding, 2_000, {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds
        },
      }),
    ).rejects.toThrow("did not activate")
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})

test("activation rejects wrong nonce, package hashes and missing Desktop health", async () => {
  const cases = [
    { nonce: "e".repeat(64) },
    { pluginPackageSha256: "e".repeat(64) },
    { nativePackageSha256: "e".repeat(64) },
  ]
  for (const change of cases) {
    const root = await mkdtemp(join(tmpdir(), "cycle-cert-wrong-binding-"))
    const binding: DesktopCertificationBinding = {
      nativePackageSha256: "d".repeat(64),
      nonce: "b".repeat(64),
      pluginPackageSha256: "c".repeat(64),
      revision: "a".repeat(40),
      root,
      startedAtUnixMillis: Date.now(),
    }
    try {
      const marker = buildDesktopActivationMarker({ ...binding, ...change }, {
        product_version: "1.0.0",
        protocol_version: 1,
        schema_mode: "read_write",
        schema_version: 17,
      }, binding.startedAtUnixMillis)
      await writeFile(join(root, "desktop-activation.json"), JSON.stringify(marker))
      await expect(waitForDesktopActivation(root, binding, 10)).rejects.toThrow("does not match")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  const root = await mkdtemp(join(tmpdir(), "cycle-cert-no-health-"))
  const binding: DesktopCertificationBinding = {
    nativePackageSha256: "d".repeat(64),
    nonce: "b".repeat(64),
    pluginPackageSha256: "c".repeat(64),
    revision: "a".repeat(40),
    root,
    startedAtUnixMillis: Date.now(),
  }
  try {
    await writeFile(join(root, "desktop-activation.json"), JSON.stringify({
      createdAtUnixMillis: binding.startedAtUnixMillis,
      nativePackageSha256: binding.nativePackageSha256,
      nonce: binding.nonce,
      pluginPackageSha256: binding.pluginPackageSha256,
      revision: binding.revision,
      schemaVersion: 1,
      type: "opencode-cycle-desktop-activation",
    }))
    await expect(waitForDesktopActivation(root, binding, 10)).rejects.toThrow("missing or unknown")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}, 20_000)

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
