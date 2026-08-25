import { expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  buildDesktopActivationMarker,
  desktopCertificationBindingDigest,
  desktopCertificationProcessToken,
  writeDesktopActivationMarker,
  type DesktopCertificationBinding,
} from "../../packages/opencode-cycle/src/certification.js"
import * as VerifiedFileModule from "../release/verified-file.js"
import type { DesktopAsset, DesktopAssetMatrix } from "./desktop-certification.js"

function daemonIdentity(binding: DesktopCertificationBinding) {
  return {
    binaryPath: join(binding.root, "workflowd.exe"),
    parentPid: process.pid,
    parentStartTimeUnixMillis: binding.startedAtUnixMillis,
    pid: 4242,
    processStartTimeUnixMillis: binding.startedAtUnixMillis,
    startToken: desktopCertificationProcessToken(binding),
    startedAtUnixMillis: binding.startedAtUnixMillis,
  }
}
const verifiedFileReader = VerifiedFileModule.createVerifiedFileReaderForTests({
  assertNoReparse: async () => undefined,
})
mock.module("../release/verified-file.js", () => ({
  ...VerifiedFileModule,
  readVerifiedFileDirectory: (directory: string) => verifiedFileReader.readDirectory(directory),
  readVerifiedRegularFile: (
    path: string,
    options?: { readonly maxBytes?: number; readonly root?: string },
  ) => verifiedFileReader.readFile(path, options),
}))

const {
  activationScanRoots,
  certificationEnvironment,
  cleanupDesktopCertificationProcesses,
  completeDesktopDaemonCleanupDiagnostic,
  desktopLoadDiagnosticSummary,
  desktopOutputSummary,
  isCertificationOnboardingProfile,
  isDesktopHarnessPath,
  desktopTestProfiles,
  desktopTestProfileRoots,
  fetchDesktopAsset,
  parseWindowsProtocolRegistration,
  prepareDesktopCertificationLoad,
  prepareDesktopModuleRuntimeGuard,
  stageDesktopAsset,
  terminateDesktopProcess,
  validateDesktopAsset,
  validateDesktopAssetMatrix,
  verifyDesktopModuleRuntime,
  waitForDesktopActivation,
  windowsDesktopExtraction,
  windowsPowerShellEnvironment,
  windowsPowerShellPath,
  SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS,
} = await import("./desktop-certification.js")
import {
  OPENCODE_11821_HOST_PROOF_PROVENANCE,
  verifyCanonicalFixture,
  type OpenCodeDesktopEnvironmentProofReceipt,
  type OpenCodeHostProofReceipt,
} from "./opencode-1.18.21-host-proof.js"

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

for (const platform of ["windows-x64", "linux-x64"] as const) {
  for (const scenario of ["success", "activation-failure", "no-marker", "shutdown-failure"] as const) {
    test(`${platform} ${scenario} teardown attempts daemon cleanup before Desktop termination`, async () => {
      const events: string[] = []
      const activationFailure = scenario === "activation-failure" || scenario === "no-marker"
        ? new Error("activation failed")
        : undefined
      const cleanup = {
        exitMarkerPublished: scenario !== "no-marker",
        markerPublished: scenario !== "no-marker",
        processAbsent: scenario !== "no-marker",
        shutdownAuthenticated: scenario !== "no-marker",
        terminated: scenario !== "no-marker",
      }
      const result = await cleanupDesktopCertificationProcesses({
        cleanupDaemon: async () => {
          events.push("daemon")
          if (scenario === "shutdown-failure") throw new Error("authenticated shutdown failed")
          return cleanup
        },
        desktopProcess: { pid: 4242 } as Bun.Subprocess,
        existingError: activationFailure,
        platform,
        terminateDesktop: async () => { events.push("desktop") },
      })

      expect(events).toEqual(["daemon", "desktop"])
      if (scenario === "shutdown-failure") {
        expect(result.error).toBeInstanceOf(Error)
        expect((result.error as Error).message).toContain("authenticated shutdown failed")
        expect(result.daemonCleanup).toBeUndefined()
      } else {
        expect(result.error).toBe(activationFailure)
        expect(result.daemonCleanup).toEqual(cleanup)
      }
    })
  }
}

const asset: DesktopAsset = {
  name: "opencode-desktop-win-x64.exe",
  runtimeExecutable: {
    name: "OpenCode.exe",
    productVersion: "1.18.21.0",
    sha256: "c96920bb1d1a4dc5cee64d33c404224e3c37c79111007e3aea861b448e2c4999",
  },
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
        runtimeExecutable: {
          name: "ai.opencode.desktop",
          productVersion: "1.18.21",
          sha256: "008c5cf72df686019c818d2cb0570df8137b49aa5dae64dcf017ea2656c5b7ac",
        },
        sha256: "fb384fc4f030aca8624d775b8757cafa39b5871fc0eddeecebb128f25ed649d8",
        size: 158_944_115,
        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.21/opencode-desktop-linux-x86_64.AppImage",
      },
      "windows-x64": {
        name: "opencode-desktop-win-x64.exe",
        runtimeExecutable: {
          name: "OpenCode.exe",
          productVersion: "1.18.21.0",
          sha256: "c96920bb1d1a4dc5cee64d33c404224e3c37c79111007e3aea861b448e2c4999",
        },
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

test("canonical OpenCode 1.18.21 LF fixtures and upstream authorities are checksum-pinned", async () => {
  await expect(verifyCanonicalFixture()).resolves.toBeUndefined()
  expect(OPENCODE_11821_HOST_PROOF_PROVENANCE).toEqual({
    commit: "826d9ad46a22bef0294998e08daa3c4904fea28f",
    files: {
      "packages/core/src/v1/config/plugin.ts": "b45a25d030b253b92449050538433c8ab4dd53db9d2c81228cd6133f4d94837c",
      "packages/desktop/src/main/server.ts": "b011cc9421ffe27bbdc18f8e18423f114636a310b7290394a19a7f1b29a8c352",
      "packages/desktop/src/main/shell-env.ts": "eb36363c87ac3f4b6a13053fe845aef045545883b6fcee3e0f4a2517194b1daa",
      "packages/opencode/src/config/config.ts": "b0fd57d860661ce70e7fbd06e7f2cc24417c70d3db4207ad97129ac1b649997e",
      "packages/opencode/src/config/paths.ts": "cd86a34461b27caf1042f8cba140fbbed47790c4f30cd9691f87298e8d4d4444",
      "packages/opencode/src/config/plugin.ts": "8c450d5c8fdee1811bb93788462958c7e58ea551c73e18a4173c19917c734f6e",
      "packages/opencode/src/plugin/index.ts": "47c62b7cfae891d268e6b239edb0f1c46df5cb35eb11ccfd8bd4186c156024e9",
      "packages/opencode/src/plugin/loader.ts": "a7eba2d328a36a2486b50245ad98ef0daa769d4109c9e50470d8493b0936c4c0",
      "packages/opencode/src/plugin/shared.ts": "1ada9e15915e47bbb7b16436f0018c9b86845a66e687d89d037be896b9663140",
    },
    license: {
      path: "LICENSE",
      sha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
    },
    normalization: "none",
    repository: "https://github.com/anomalyco/opencode",
    scope: "test-only canonical copies excluded from production archives",
    tag: "v1.18.21",
  })
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

test("Linux certification owns every shell, temp and OpenCode home override", () => {
  const root = resolve(tmpdir(), "cycle-cert-owned-effective-env")
  const environment = certificationEnvironment(root, "linux-x64", {
    HOME: "/owner/home",
    OPENCODE_TEST_HOME: "/owner/test-home",
    PATH: "/safe/bin",
    SHELL: "/owner/profile-shell",
    TEMP: "/owner/temp",
    TMP: "/owner/tmp",
    TMPDIR: "/owner/tmpdir",
    XDG_CONFIG_HOME: "/owner/config",
  })

  for (const name of ["TEMP", "TMP", "TMPDIR", "OPENCODE_TEST_HOME", "SHELL"] as const) {
    expect(environment[name]).toBeString()
    expect(isDesktopHarnessPath(environment[name] as string, root)).toBe(true)
  }
  expect(basename(environment.SHELL as string)).toBe("nu")
  const roots = desktopTestProfileRoots(environment, root)
  expect(roots.length).toBeGreaterThan(0)
  expect(roots.every((path) => isDesktopHarnessPath(path, root))).toBe(true)
  expect(roots.join(" ")).not.toContain("/owner")
})

test("Linux certification shell emitter is profile-free and contains only isolated bindings", async () => {
  const fixture = await createDesktopLoadFixture(undefined, "linux-x64")
  try {
    expect(fixture.prepared.shellWrapper).toBeString()
    const source = await readFile(fixture.prepared.shellWrapper as string, "utf8")
    expect(source).toBe("#!/bin/sh\nexit 1\n")
    expect(source).not.toContain(fixture.environment.HOME as string)
    expect(source).not.toContain(fixture.binding.nonce)
    if (process.platform === "linux") {
      for (const argumentsList of [["--version"], ["-c", "env -0"]]) {
        const child = Bun.spawn([fixture.prepared.shellWrapper as string, ...argumentsList], {
          env: { HOME: "/owner/home", XDG_CONFIG_HOME: "/owner/config" },
          stderr: "pipe",
          stdout: "pipe",
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(exitCode).not.toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
      }
    }
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

async function createDesktopLoadFixture(candidateSource = `
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function CandidateFixture(input, options) {
  await writeFile(join(options.certification.root, "desktop-daemon-runtime.json"), "{}\\n")
  await writeFile(join(options.certification.root, "fixture-result.json"), JSON.stringify({
    binaryPath: options.binaryPath,
    certificationRoot: options.certification.root,
    dataDirectory: options.dataDirectory,
    directory: input.directory,
    hostVersion: options.hostVersion,
    optionKeys: Object.keys(options).sort(),
    worktree: input.worktree,
  }))
  return {
    dispose: async () => {},
  }
}
CandidateFixture.finalizeDesktopCertification = async () => {}
`, platform: "linux-x64" | "windows-x64" = "windows-x64") {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-cert-desktop-load-"))
  const certificationRoot = join(temporary, "certification")
  const packedPlugin = join(temporary, "packed-plugin")
  const nativeExecutable = join(temporary, "input", platform === "windows-x64" ? "workflowd.exe" : "workflowd")
  const dataDirectory = join(temporary, "workflow-data")
  await Promise.all([
    mkdir(certificationRoot),
    mkdir(join(packedPlugin, "dist"), { recursive: true }),
    mkdir(join(temporary, "input")),
  ])
  await Promise.all([
    writeFile(
      join(packedPlugin, "package.json"),
      `${JSON.stringify({ exports: { ".": "./dist/index.js" }, type: "module" })}\n`,
    ),
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
    platform,
    { PATH: "safe-path" },
    binding,
  )
  const effectiveEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    HOME: join(temporary, "desktop-shell-home"),
    XDG_CONFIG_HOME: join(temporary, "desktop-profile", "config"),
  }
  const prepared = await prepareDesktopCertificationLoad({
    certification: binding,
    dataDirectory,
    environment: effectiveEnvironment,
    hostVersion: "1.18.21",
    nativeExecutable,
    packedPlugin,
    platform,
    scratch: temporary,
  })
  return {
    binding,
    dataDirectory,
    environment: effectiveEnvironment,
    nativeExecutable,
    prepared,
    temporary,
  }
}

test("canonical Linux preferAppEnv skips conflicting login-shell bindings before config discovery", async () => {
  if (process.platform !== "linux") return
  const fixture = await createDesktopLoadFixture(undefined, "linux-x64")
  try {
    const shell = fixture.prepared.shellWrapper as string
    const invocationMarker = join(fixture.temporary, "nu-invoked")
    await writeFile(
      shell,
      [
        "#!/bin/sh",
        `touch ${JSON.stringify(invocationMarker)}`,
        "exec /usr/bin/env -i \\",
        "  'HOME=/owner/home' \\",
        "  'XDG_CONFIG_HOME=/owner/config' \\",
        "  'OPENCODE_CONFIG_DIR=/owner/opencode' \\",
        "  'OPENCODE_CONFIG=/owner/opencode/opencode.json' \\",
        "  /usr/bin/env -0",
        "",
      ].join("\n"),
      "utf8",
    )
    await chmod(shell, 0o700)
    const request = join(fixture.temporary, "desktop-environment-proof-request.json")
    const result = join(fixture.temporary, "desktop-environment-proof-result.json")
    await writeFile(request, `${JSON.stringify({
      configDirectory: fixture.prepared.configDirectory,
      configFile: fixture.prepared.configFile,
      directory: fixture.temporary,
      resultFile: result,
      scratch: fixture.temporary,
      userDataPath: join(fixture.temporary, "desktop-user-data"),
      worktree: fixture.temporary,
    })}\n`)
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "opencode-1.18.21-host-proof.ts"),
        "--desktop-environment-request",
        request,
      ],
      {
        cwd: fixture.temporary,
        env: fixture.environment,
        stderr: "ignore",
        stdout: "ignore",
      },
    )
    expect(await child.exited).toBe(0)
    expect(JSON.parse(await readFile(result, "utf8")) as OpenCodeDesktopEnvironmentProofReceipt).toEqual({
      configDirectoryDiscovered: true,
      configFileDiscovered: true,
      provenanceCommit: OPENCODE_11821_HOST_PROOF_PROVENANCE.commit,
      shellEnvironmentSkipped: true,
    })
    expect(await access(invocationMarker).then(() => true, () => false)).toBe(false)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
}, 20_000)

test("native certification requires an official Electron module-runtime guard before Desktop launch", async () => {
  const module = await import("./desktop-certification.js") as Record<string, unknown>
  expect(module.verifyDesktopModuleRuntime).toBeFunction()
  const source = await readFile(resolve(import.meta.dir, "desktop-certification.ts"), "utf8")
  const guard = source.indexOf("await verifyDesktopModuleRuntime(")
  const launch = source.indexOf("desktopProcess = Bun.spawn(")
  expect(guard).toBeGreaterThan(0)
  expect(launch).toBeGreaterThan(guard)
})

test("Desktop runtime guard uses the trusted non-evaluating linker under the pinned runtime", async () => {
  const node = Bun.which("node")
  expect(node).toBeString()
  const fixture = await createDesktopLoadFixture()
  try {
    const plan = await prepareDesktopModuleRuntimeGuard({
      binding: fixture.binding,
      cwd: fixture.temporary,
      environment: fixture.environment,
      hostVersion: "1.18.21",
      platform: "windows-x64",
      prepared: fixture.prepared,
      runtimeCommand: [node as string],
      scratch: fixture.temporary,
    })
    const linkerSource = await readFile(plan.expected.linker, "utf8")
    const syntax = Bun.spawn([node as string, "--check", plan.expected.linker], {
      stderr: "ignore",
      stdout: "ignore",
      windowsHide: true,
    })
    expect(await syntax.exited).toBe(0)
    expect(plan.command).toEqual([
      node as string,
      "--no-warnings",
      "--experimental-vm-modules",
      "--experimental-import-meta-resolve",
      plan.expected.linker,
    ])
    expect(linkerSource).toContain("await entry.link(")
    expect(linkerSource).toContain("SourceTextModule")
    expect(linkerSource).not.toContain(".evaluate(")
    expect(linkerSource).not.toContain("fork(")
    expect(linkerSource).not.toContain("createHmac")
    expect(linkerSource).not.toContain("await import(pathToFileURL(expected.candidateEntry)")
    expect(plan.expected.runtimeExecutableSha256).toBe(
      "c96920bb1d1a4dc5cee64d33c404224e3c37c79111007e3aea861b448e2c4999",
    )
    expect(plan.expected.runtimeProductVersion).toBe("1.18.21.0")
    expect(plan.expected.dependencyTree).toEqual(fixture.prepared.dependencyTree)
    expect(plan.expected.linkerSha256).toMatch(/^[0-9a-f]{64}$/u)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("Desktop runtime authority exposes no candidate-child HMAC path", async () => {
  const module = await import("./desktop-certification.js") as Record<string, unknown>
  const source = await readFile(resolve(import.meta.dir, "desktop-certification.ts"), "utf8")
  expect(module.createDesktopRuntimeAcknowledgement).toBeUndefined()
  expect(module.validateDesktopRuntimeChildResult).toBeUndefined()
  expect(source).not.toContain("desktopRuntimeChildSource")
  expect(source).not.toContain("desktopRuntimeSupervisorSource")
  expect(source).toContain("candidateEvaluated: false")
  expect(source).toContain("moduleLinked: true")
})

test("Desktop dependency proof rejects ancestor fallback and binds a contained tree", async () => {
  const module = await import("./desktop-certification.js") as Record<string, unknown>
  const verifyTree = module.verifyDesktopDependencyTree
  expect(verifyTree).toBeFunction()
  if (typeof verifyTree !== "function") return
  const temporary = await mkdtemp(join(tmpdir(), "cycle-contained-dependencies-"))
  const installed = join(temporary, "stage", "opencode-cycle")
  const ancestorDependency = join(temporary, "node_modules", "fixture-dependency")
  try {
    await Promise.all([
      mkdir(join(installed, "dist"), { recursive: true }),
      mkdir(ancestorDependency, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(installed, "package.json"), JSON.stringify({
        dependencies: { "fixture-dependency": "1.0.0" },
        exports: { ".": "./dist/index.js" },
        type: "module",
      }) + "\n"),
      writeFile(join(installed, "dist", "index.js"), "export default () => ({})\n"),
      writeFile(join(ancestorDependency, "package.json"), JSON.stringify({
        name: "fixture-dependency",
        version: "1.0.0",
      }) + "\n"),
      writeFile(join(ancestorDependency, "index.js"), "export default true\n"),
    ])
    await expect((verifyTree as (root: string) => Promise<unknown>)(installed))
      .rejects.toThrow("contained")
    await rm(join(temporary, "node_modules"), { force: true, recursive: true })

    const contained = join(installed, "node_modules", "fixture-dependency")
    await mkdir(contained, { recursive: true })
    await Promise.all([
      writeFile(join(contained, "package.json"), JSON.stringify({
        name: "fixture-dependency",
        version: "1.0.0",
      }) + "\n"),
      writeFile(join(contained, "index.js"), "export default true\n"),
    ])
    const receipt = await (verifyTree as (root: string) => Promise<Record<string, unknown>>)(installed)
    expect(receipt).toMatchObject({
      dependencyFileCount: 2,
      dependencyPackageCount: 1,
      schemaVersion: 1,
    })
    expect(receipt.dependencyTreeSha256).toMatch(/^[0-9a-f]{64}$/u)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})

test("package unit coverage never overwrites process runtime identity", async () => {
  const source = await readFile(resolve(import.meta.dir, "test-packed-plugin.ts"), "utf8")
  expect(source).not.toContain("Object.defineProperty(process.versions")
})

test("production Desktop helpers expose no optional verified-file reader overrides", async () => {
  const source = await readFile(resolve(import.meta.dir, "desktop-certification.ts"), "utf8")
  expect(source).not.toContain("readFileBoundary?:")
  expect(source).not.toContain("readonly readFile?: typeof readVerifiedRegularFile")
  expect(source).not.toContain("dependencies.readFile")
})

async function runHostProof(
  fixture: Awaited<ReturnType<typeof createDesktopLoadFixture>>,
  label: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<OpenCodeHostProofReceipt> {
  const project = join(fixture.temporary, "project")
  const onboarding = join(fixture.temporary, "temp", `opencode-onboarding-${label}`)
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(onboarding, "config"), { recursive: true }),
    mkdir(join(onboarding, "cache"), { recursive: true }),
    mkdir(join(onboarding, "data"), { recursive: true }),
    mkdir(join(onboarding, "state"), { recursive: true }),
  ])
  const request = join(fixture.temporary, `${label}-host-proof-request.json`)
  const result = join(fixture.temporary, `${label}-host-proof-result.json`)
  await writeFile(request, `${JSON.stringify({
    binding: fixture.binding,
    candidatePackageRoot: fixture.prepared.installedPlugin,
    configFile: fixture.prepared.configFile,
    directory: project,
    resultFile: result,
    worktree: project,
  })}\n`)
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "opencode-1.18.21-host-proof.ts"), "--request", request],
    {
      cwd: fixture.temporary,
      env: {
        ...fixture.environment,
        XDG_CACHE_HOME: join(onboarding, "cache"),
        XDG_CONFIG_HOME: join(onboarding, "config"),
        XDG_DATA_HOME: join(onboarding, "data"),
        XDG_STATE_HOME: join(onboarding, "state"),
        ...overrides,
      },
      stderr: "ignore",
      stdout: "ignore",
    },
  )
  if ((await child.exited) !== 0) throw new Error("OpenCode 1.18.21 host proof failed")
  return JSON.parse(await readFile(result, "utf8")) as OpenCodeHostProofReceipt
}

test("loaded host probe rejects post-overlay owner paths before candidate import", async () => {
  const fixture = await createDesktopLoadFixture()
  try {
    const ownerPath = process.platform === "win32" ? "C:\\owner\\home" : "/owner/home"
    await expect(runHostProof(fixture, "owner-overlay", { HOME: ownerPath })).rejects.toThrow(
      "host proof failed",
    )
    const summary = await desktopLoadDiagnosticSummary(fixture.binding.root, fixture.binding)
    expect(summary).toContain("plugin_specifier_resolved=passed")
    expect(summary).toContain("effective_env_validated=config_root_failed")
    expect(await access(join(fixture.binding.root, "fixture-result.json")).then(() => true, () => false)).toBe(false)
    expect(await readFile(fixture.prepared.diagnosticsFile, "utf8")).not.toContain(ownerPath)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
}, 20_000)

test("bound Desktop config resolves and executes the candidate from the copied package layout", async () => {
  const fixture = await createDesktopLoadFixture()
  try {
    const config = JSON.parse(await readFile(fixture.prepared.configFile, "utf8")) as {
      $schema: string
      plugin: [[string, Record<string, unknown>]]
    }
    expect(config).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugin: [[
        pathToFileURL(fixture.prepared.pluginLoader).href,
        {
          binaryPath: join(fixture.prepared.installedPlugin, "bin", "workflowd.exe"),
          certification: fixture.binding,
          dataDirectory: fixture.dataDirectory,
          hostVersion: "1.18.21",
        },
      ]],
    })

    const proof = await runHostProof(fixture, "success")
    expect(proof).toMatchObject({
      bindingDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      deduplicatedOrigins: 1,
      loadedPlugins: 1,
      mergedOrigins: 3,
      provenanceCommit: OPENCODE_11821_HOST_PROOF_PROVENANCE.commit,
      tupleOptions: true,
    })
    expect(JSON.parse(await readFile(join(fixture.binding.root, "fixture-result.json"), "utf8"))).toEqual({
      binaryPath: join(fixture.prepared.installedPlugin, "bin", "workflowd.exe"),
      certificationRoot: fixture.binding.root,
      dataDirectory: fixture.dataDirectory,
      directory: join(fixture.temporary, "project"),
      hostVersion: "1.18.21",
      optionKeys: ["binaryPath", "certification", "dataDirectory", "hostVersion"],
      worktree: join(fixture.temporary, "project"),
    })
    await writeDesktopActivationMarker(
      fixture.binding,
      {
        product_version: "1.0.0",
        protocol_version: 1,
        schema_mode: "read_write",
        schema_version: 17,
      },
      {
        binaryPath: join(fixture.prepared.installedPlugin, "bin", "workflowd.exe"),
        parentPid: process.pid,
        parentStartTimeUnixMillis: fixture.binding.startedAtUnixMillis,
        pid: 4242,
        processStartTimeUnixMillis: fixture.binding.startedAtUnixMillis,
        startToken: desktopCertificationProcessToken(fixture.binding),
        startedAtUnixMillis: fixture.binding.startedAtUnixMillis,
      },
    )
    await waitForDesktopActivation(fixture.binding.root, fixture.binding, 10)
    await completeDesktopDaemonCleanupDiagnostic(
      fixture.prepared.diagnosticsFile,
      fixture.binding,
      "passed",
    )
    expect(await desktopLoadDiagnosticSummary(fixture.binding.root, fixture.binding)).toBe(
      "certification_env_prepared=passed, config_tree_prepared=passed, " +
      "config_path_discovered=passed, plugin_specifier_resolved=passed, " +
      "effective_env_validated=passed, candidate_module_resolved=passed, " +
      "plugin_entry_started=passed, plugin_entry_completed=passed, " +
      "daemon_identity_published=passed, activation_marker_verified=passed, " +
      "daemon_cleanup_verified=passed",
    )
    const diagnostics = await readFile(fixture.prepared.diagnosticsFile, "utf8")
    expect(diagnostics).not.toContain(fixture.temporary)
    expect(diagnostics).not.toContain(fixture.binding.nonce)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
}, 20_000)

test("Desktop config carries one exact tuple through official merge and dedup", async () => {
  const fixture = await createDesktopLoadFixture()
  try {
    const config = JSON.parse(await readFile(fixture.prepared.configFile, "utf8")) as {
      plugin: unknown[]
    }
    expect(config.plugin).toHaveLength(1)
    expect(config.plugin[0]).toEqual([
      pathToFileURL(fixture.prepared.pluginLoader).href,
      {
        binaryPath: join(fixture.prepared.installedPlugin, "bin", "workflowd.exe"),
        certification: fixture.binding,
        dataDirectory: fixture.dataDirectory,
        hostVersion: "1.18.21",
      },
    ])
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("Desktop load diagnostics fail closed at candidate module resolution without leaking details", async () => {
  const fixture = await createDesktopLoadFixture()
  try {
    await rm(join(fixture.prepared.installedPlugin, "dist", "index.js"))

    await expect(runHostProof(fixture, "missing-candidate")).rejects.toThrow("host proof failed")
    const summary = await desktopLoadDiagnosticSummary(fixture.binding.root, fixture.binding)
    expect(summary).toContain("config_path_discovered=passed")
    expect(summary).toContain("plugin_specifier_resolved=passed")
    expect(summary).toContain("candidate_module_resolved=module_not_found")
    expect(summary).toContain("plugin_entry_started=missing")
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
    ).rejects.toThrow("candidate_module_resolved=module_not_found")
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
}, 20_000)

test("Desktop load diagnostics distinguish export mismatch from dependency resolution", async () => {
  const node = Bun.which("node")
  expect(node).toBeString()
  for (const scenario of ["export-mismatch", "dependency-resolution"] as const) {
    const fixture = await createDesktopLoadFixture(
      scenario === "dependency-resolution"
        ? `import "opencode-cycle-missing-dependency"\nexport default async function CandidateFixture() { return {} }\n`
        : undefined,
    )
    try {
      if (scenario === "export-mismatch") {
        const manifest = JSON.parse(
          await readFile(join(fixture.prepared.installedPlugin, "package.json"), "utf8"),
        ) as { exports: Record<string, string> }
        manifest.exports["."] = "./dist/alternate.js"
        await writeFile(
          join(fixture.prepared.installedPlugin, "package.json"),
          `${JSON.stringify(manifest)}\n`,
        )
      }
      const child = Bun.spawn([node as string, fixture.prepared.pluginLoader], {
        cwd: fixture.temporary,
        env: fixture.environment,
        stderr: "ignore",
        stdout: "ignore",
      })
      expect(await child.exited).toBe(1)
      const summary = await desktopLoadDiagnosticSummary(fixture.binding.root, fixture.binding)
      expect(summary).toContain(
        `candidate_module_resolved=${scenario === "export-mismatch"
          ? "export_mismatch"
          : "dependency_resolution_failed"}`,
      )
      const diagnostics = await readFile(fixture.prepared.diagnosticsFile, "utf8")
      expect(diagnostics).not.toContain(fixture.temporary)
    } finally {
      await rm(fixture.temporary, { force: true, recursive: true })
    }
  }
}, 20_000)

test("Desktop timeout classifies a missing config import without exposing its root", async () => {
  const fixture = await createDesktopLoadFixture()
  try {
    let clock = fixture.binding.startedAtUnixMillis
    await expect(waitForDesktopActivation(fixture.binding.root, fixture.binding, 1, {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
    })).rejects.toThrow("config_path_discovered=shell_or_config_root_failed")
    const diagnostics = await readFile(fixture.prepared.diagnosticsFile, "utf8")
    expect(diagnostics).not.toContain(fixture.temporary)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
}, 20_000)

test("Desktop load diagnostics isolate candidate entry failure without recording its message", async () => {
  const privateFailure = "private provider and model fixture must not enter diagnostics"
  const fixture = await createDesktopLoadFixture(`
export default async function CandidateFixture() {
  throw new Error(${JSON.stringify(privateFailure)})
}
  `)
  try {
    await expect(runHostProof(fixture, "entry-failure")).rejects.toThrow("host proof failed")

    const summary = await desktopLoadDiagnosticSummary(fixture.binding.root, fixture.binding)
    expect(summary).toContain("candidate_module_resolved=passed")
    expect(summary).toContain("plugin_entry_completed=failed")
    const diagnostics = await readFile(fixture.prepared.diagnosticsFile, "utf8")
    expect(diagnostics).not.toContain(privateFailure)
    expect(diagnostics).not.toContain(fixture.temporary)
    expect(diagnostics).not.toContain(fixture.binding.nonce)
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
}, 20_000)

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
    await expect(desktopLoadDiagnosticSummary(root, binding)).rejects.toThrow("transcript")

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

test("Desktop output diagnostics expose only bounded byte counts and digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-output-summary-"))
  const secret = "private provider model token C:\\owner\\config"
  const stdout = join(root, "stdout.log")
  const stderr = join(root, "stderr.log")
  try {
    await Promise.all([writeFile(stdout, secret), writeFile(stderr, `error ${secret}`)])
    const summary = await desktopOutputSummary(stdout, stderr, root)
    expect(summary).toContain(`stdout_bytes=${Buffer.byteLength(secret)}`)
    expect(summary).toContain(createHash("sha256").update(secret).digest("hex"))
    expect(summary).not.toContain(secret)
    expect(summary).not.toContain(root)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

for (const scenario of ["duplicate", "out-of-order", "failure-overwrite", "stale"] as const) {
  test(`Desktop load transcript rejects ${scenario} records`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cycle-cert-invalid-transcript-"))
    const binding: DesktopCertificationBinding = {
      nativePackageSha256: "d".repeat(64),
      nonce: "b".repeat(64),
      pluginPackageSha256: "c".repeat(64),
      revision: "a".repeat(40),
      root,
      startedAtUnixMillis: 1_700_000_000_000,
    }
    const runDigest = desktopCertificationBindingDigest(binding)
    const record = (sequence: number, stage: string, status: "failed" | "passed", digest = runDigest) => ({
      runDigest: digest,
      schemaVersion: 2,
      sequence,
      stage,
      status,
      type: "opencode-cycle-desktop-load-diagnostic",
    })
    const records = {
      duplicate: [
        record(0, "certification_env_prepared", "passed"),
        record(1, "certification_env_prepared", "passed"),
      ],
      "out-of-order": [record(0, "config_tree_prepared", "passed")],
      "failure-overwrite": [
        record(0, "certification_env_prepared", "failed"),
        record(1, "config_tree_prepared", "passed"),
      ],
      stale: [record(0, "certification_env_prepared", "passed", "e".repeat(64))],
    }[scenario]
    try {
      await writeFile(
        join(root, "desktop-load-diagnostics.jsonl"),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      )
      await expect(desktopLoadDiagnosticSummary(root, binding)).rejects.toThrow("transcript")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
}

test("a complete passing load transcript can never replace the activation marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-transcript-no-marker-"))
  const binding: DesktopCertificationBinding = {
    nativePackageSha256: "d".repeat(64),
    nonce: "b".repeat(64),
    pluginPackageSha256: "c".repeat(64),
    revision: "a".repeat(40),
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  const stages = [
    "certification_env_prepared",
    "config_tree_prepared",
    "config_path_discovered",
    "plugin_specifier_resolved",
    "effective_env_validated",
    "candidate_module_resolved",
    "plugin_entry_started",
    "plugin_entry_completed",
    "daemon_identity_published",
  ]
  try {
    await writeFile(
      join(root, "desktop-load-diagnostics.jsonl"),
      `${stages.map((stage, sequence) => JSON.stringify({
        runDigest: desktopCertificationBindingDigest(binding),
        schemaVersion: 2,
        sequence,
        stage,
        status: "passed",
        type: "opencode-cycle-desktop-load-diagnostic",
      })).join("\n")}\n`,
    )
    let clock = binding.startedAtUnixMillis
    await expect(waitForDesktopActivation(root, binding, 1, {
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
    })).rejects.toThrow("did not activate")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("canonical candidate entry cannot publish activation before wrapper finalization", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "../../packages/opencode-cycle/src/index.ts"),
    "utf8",
  )
  expect(source).not.toContain("writeDesktopActivationMarker(")
})

test("activation remains absent until the durable candidate finalizer stage completes", async () => {
  const certificationModule = pathToFileURL(
    resolve(import.meta.dir, "../../packages/opencode-cycle/src/certification.ts"),
  ).href
  const fixture = await createDesktopLoadFixture(`
import { access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  desktopCertificationBindingDigest,
  desktopCertificationProcessToken,
  finalizeDesktopActivation,
} from ${JSON.stringify(certificationModule)}

let pending
export default async function CandidateFixture(input, options) {
  const daemon = {
    binaryPath: options.binaryPath,
    parentPid: process.ppid,
    parentStartTimeUnixMillis: options.certification.startedAtUnixMillis,
    pid: process.pid,
    processStartTimeUnixMillis: options.certification.startedAtUnixMillis,
    startToken: desktopCertificationProcessToken(options.certification),
    startedAtUnixMillis: options.certification.startedAtUnixMillis,
  }
  await writeFile(
    join(options.certification.root, "desktop-daemon-runtime.json"),
    JSON.stringify({
      daemon,
      runDigest: desktopCertificationBindingDigest(options.certification),
      schemaVersion: 1,
      type: "opencode-cycle-desktop-daemon-runtime",
    }) + "\\n",
  )
  pending = { binding: options.certification, daemon }
  return { dispose: async () => {} }
}

CandidateFixture.finalizeDesktopCertification = async (_hooks, diagnosticsFile) => {
  const root = pending.binding.root
  await writeFile(join(root, "finalizer-ready"), "ready\\n", { flag: "wx" })
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await access(join(root, "finalizer-release")).then(() => true, () => false)) break
    await Bun.sleep(25)
  }
  if (!await access(join(root, "finalizer-release")).then(() => true, () => false)) {
    throw new Error("finalizer release was not published")
  }
  await finalizeDesktopActivation(
    pending.binding,
    {
      product_version: "1.0.0",
      protocol_version: 1,
      schema_mode: "read_write",
      schema_version: 17,
    },
    pending.daemon,
    diagnosticsFile,
  )
}
`)
  const launcherTemporary = await mkdtemp(join(tmpdir(), "cycle-host-proof-launcher-"))
  const launcher = join(launcherTemporary, "launcher.ts")
  const project = join(fixture.temporary, "race-project")
  const request = join(fixture.temporary, "race-host-proof-request.json")
  const result = join(fixture.temporary, "race-host-proof-result.json")
  const activation = join(fixture.binding.root, "desktop-activation.json")
  const ready = join(fixture.binding.root, "finalizer-ready")
  const release = join(fixture.binding.root, "finalizer-release")
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(fixture.environment.TEMP as string, { recursive: true }),
    ])
    await writeFile(launcher, `
const [cwd, ...command] = Bun.argv.slice(2)
if (!cwd || command.length === 0) throw new Error("launcher arguments are missing")
const child = Bun.spawn(command, {
  cwd,
  env: process.env,
  stderr: "ignore",
  stdout: "ignore",
})
process.exit(await child.exited)
`)
    await writeFile(request, `${JSON.stringify({
      binding: fixture.binding,
      candidatePackageRoot: fixture.prepared.installedPlugin,
      configFile: fixture.prepared.configFile,
      directory: project,
      resultFile: result,
      worktree: project,
    })}\n`)
    child = Bun.spawn(
      [
        process.execPath,
        launcher,
        fixture.temporary,
        process.execPath,
        resolve(import.meta.dir, "opencode-1.18.21-host-proof.ts"),
        "--request",
        request,
      ],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: fixture.environment,
        stderr: "ignore",
        stdout: "ignore",
      },
    )
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await access(ready).then(() => true, () => false)) break
      if (child.exitCode !== null) throw new Error("host proof exited before finalizer synchronization")
      await Bun.sleep(25)
    }
    expect(await access(ready).then(() => true, () => false)).toBe(true)
    expect(await access(activation).then(() => true, () => false)).toBe(false)
    expect(await desktopLoadDiagnosticSummary(fixture.binding.root, fixture.binding)).toBe(
      "certification_env_prepared=passed, config_tree_prepared=passed, " +
      "config_path_discovered=passed, plugin_specifier_resolved=passed, " +
      "effective_env_validated=passed, candidate_module_resolved=passed, " +
      "plugin_entry_started=passed, plugin_entry_completed=passed, " +
      "daemon_identity_published=passed, activation_marker_verified=missing, " +
      "daemon_cleanup_verified=missing",
    )

    await writeFile(release, "release\n", { flag: "wx" })
    expect(await child.exited).toBe(0)
    const marker = await waitForDesktopActivation(fixture.binding.root, fixture.binding, 1_000)
    expect(marker.marker.daemon.pid).toBeGreaterThan(0)
    expect(marker.marker.runDigest).toBe(desktopCertificationBindingDigest(fixture.binding))
    expect(await access(result).then(() => true, () => false)).toBe(true)
  } finally {
    await writeFile(release, "release\n", { flag: "wx" }).catch(() => undefined)
    if (child !== undefined && child.exitCode === null) await child.exited
    await Promise.all([
      rm(fixture.temporary, { force: true, recursive: true }),
      rm(launcherTemporary, { force: true, recursive: true }),
    ])
  }
}, 20_000)

test("certification scratch directories are not treated as Desktop test profiles", () => {
  const scratch = join(tmpdir(), "opencode-cycle-desktop-certification-scratch")
  expect(isDesktopHarnessPath(scratch, scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(scratch, "home"), scratch)).toBe(true)
  expect(isDesktopHarnessPath(join(scratch, "project"), scratch)).toBe(true)
  expect(isCertificationOnboardingProfile(join(scratch, "temp", "opencode-onboarding-fresh"), scratch)).toBe(true)
  expect(isCertificationOnboardingProfile(join(scratch, "project"), scratch)).toBe(false)
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
    }, daemonIdentity(binding), clock)
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
      const changedBinding = { ...binding, ...change }
      const marker = buildDesktopActivationMarker(changedBinding, {
        product_version: "1.0.0",
        protocol_version: 1,
        schema_mode: "read_write",
        schema_version: 17,
      }, daemonIdentity(changedBinding), binding.startedAtUnixMillis)
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
        runtimeExecutable: {
          name: "fixture-runtime",
          productVersion: "1.18.21",
          sha256: "f".repeat(64),
        },
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
