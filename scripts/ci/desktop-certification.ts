import { randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep, win32 } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  parseDesktopActivationMarker,
  type DesktopActivationMarker,
  type DesktopCertificationBinding,
} from "../../packages/opencode-cycle/src/certification.js"

import {
  CERTIFIED_PLATFORMS,
  DESKTOP_ASSET_METADATA,
  DESKTOP_ASSET_NAMES,
  OPENCODE_DESKTOP_VERSION,
  type CertifiedPlatform,
} from "../release/release-manifest.js"
import { PRODUCT_IDENTITY } from "../product-identity.js"
import { readVerifiedFileDirectory, readVerifiedRegularFile, type VerifiedFile } from "../release/verified-file.js"
import { assertSourceUnchanged, captureCleanSource } from "./source-state.js"

export interface DesktopAsset {
  readonly name: string
  readonly sha256: string
  readonly size: number
  readonly url: string
}

export interface DesktopAssetMatrix {
  readonly assets: Readonly<Record<CertifiedPlatform, DesktopAsset>>
  readonly release: string
  readonly version: string
}

interface WindowsProtocolRegistration {
  readonly command?: string
  readonly existed: boolean
}

type DesktopAuthenticity =
  | {
      readonly applicationSigner: string
      readonly installerSigner: string
      readonly method: "authenticode"
      readonly status: "verified"
    }
  | { readonly method: "sha256"; readonly status: "verified" }

export const SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS = CERTIFIED_PLATFORMS

export function validateDesktopAsset(
  platform: CertifiedPlatform,
  asset: DesktopAsset,
  version: string,
): void {
  if (asset.name !== DESKTOP_ASSET_NAMES[platform]) {
    throw new Error(`${platform} Desktop asset name is invalid`)
  }
  const prefix = `https://github.com/anomalyco/opencode/releases/download/v${version}/`
  if (!asset.url.startsWith(prefix) || !asset.url.endsWith(`/${asset.name}`)) {
    throw new Error(`${platform} Desktop asset is not an official release URL`)
  }
  if (!/^[0-9a-f]{64}$/u.test(asset.sha256)) throw new Error(`${platform} Desktop asset has invalid SHA-256`)
  if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
    throw new Error(`${platform} Desktop asset has invalid size`)
  }
}

export function validateDesktopAssetMatrix(matrix: DesktopAssetMatrix): void {
  if (matrix.version !== OPENCODE_DESKTOP_VERSION) {
    throw new Error("Desktop asset matrix version is invalid")
  }
  if (matrix.release !== `https://github.com/anomalyco/opencode/releases/tag/v${matrix.version}`) {
    throw new Error("Desktop asset matrix release URL is invalid")
  }
  const platforms = Object.keys(matrix.assets).sort()
  if (
    platforms.length !== SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS.length ||
    !SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS.every((platform) => platforms.includes(platform))
  ) {
    throw new Error("Desktop asset matrix platform set is invalid")
  }
  for (const platform of SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS) {
    validateDesktopAsset(platform, matrix.assets[platform], matrix.version)
    const expected = DESKTOP_ASSET_METADATA[platform]
    if (
      matrix.assets[platform].name !== expected.name ||
      matrix.assets[platform].sha256 !== expected.sha256 ||
      matrix.assets[platform].size !== expected.size
    ) {
      throw new Error(`${platform} Desktop asset metadata does not match the official release`)
    }
  }
}

async function requireSourceRevision(root: string, revision: string): Promise<void> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) {
    throw new Error("Desktop certification revision must be a full Git object ID")
  }
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Cannot resolve Desktop certification revision: ${stderr.trim()}`)
  if (stdout.trim() !== revision) {
    throw new Error("Desktop certification revision does not match the checked-out source")
  }
}

export function certificationEnvironment(
  root: string,
  platform: CertifiedPlatform,
  inherited: NodeJS.ProcessEnv,
  certification?: Pick<DesktopCertificationBinding, "nonce" | "root">,
): NodeJS.ProcessEnv {
  const isolated = resolve(root)
  const allowed = [
    "CI",
    "ComSpec",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "GITHUB_ACTIONS",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "LOGNAME",
    "NUMBER_OF_PROCESSORS",
    "PATHEXT",
    "PATH",
    "Path",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "PROCESSOR_ARCHITECTURE",
    "SHELL",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "USER",
    "USERNAME",
    "WAYLAND_DISPLAY",
    "WINDIR",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
  ] as const
  const base: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = inherited[name]
    if (value !== undefined) base[name] = value
  }
  return {
    ...base,
    PATH:
      inherited.PATH ?? inherited.Path ??
      (platform === "linux-x64"
        ? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        : ""),
    APPDATA: join(isolated, "appdata"),
    HOME: join(isolated, "home"),
    HOMEDRIVE: platform === "windows-x64" && win32.parse(isolated).root !== ""
      ? win32.parse(isolated).root.replace(/\\$/u, "")
      : undefined,
    HOMEPATH: platform === "windows-x64" ? join(isolated, "home").replace(/^[A-Za-z]:/u, "") : undefined,
    LOCALAPPDATA: join(isolated, "localappdata"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    USERPROFILE: join(isolated, "home"),
    XDG_CACHE_HOME: join(isolated, "xdg", "cache"),
    XDG_CONFIG_HOME: join(isolated, "xdg", "config"),
    XDG_DATA_HOME: join(isolated, "xdg", "data"),
    XDG_STATE_HOME: join(isolated, "xdg", "state"),
    ...(certification === undefined
      ? {}
      : {
          CYCLE_CERTIFICATION_NONCE: certification.nonce,
          CYCLE_CERTIFICATION_ROOT: certification.root,
        }),
    ...(platform === "windows-x64" ? { OPENCODE_TEST_ONBOARDING: "1" } : {}),
  }
}

export function windowsPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot
  if (!systemRoot) throw new Error("Windows signature verification requires SystemRoot")
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

export function windowsPowerShellEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const systemRoot = environment.SystemRoot
  if (!systemRoot) throw new Error("Windows signature verification requires SystemRoot")
  return {
    ...environment,
    PSModulePath: win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    ),
  }
}

export function windowsDesktopExtraction(
  asset: string,
  scratch: string,
  environment: NodeJS.ProcessEnv,
): { commands: string[][]; executable: string; extractor: string } {
  const programFiles = environment.ProgramFiles
  if (!programFiles) throw new Error("Windows Desktop extraction requires ProgramFiles")
  const extractor = win32.join(programFiles, "7-Zip", "7z.exe")
  const archiveDirectory = win32.join(scratch, "nsis")
  const directory = win32.join(scratch, "desktop")
  const nested = win32.join(archiveDirectory, "$PLUGINSDIR", "app-64.7z")
  return {
    commands: [
      [extractor, "x", asset, `-o${archiveDirectory}`, "-y", "-ir!$PLUGINSDIR\\app-64.7z"],
      [extractor, "x", nested, `-o${directory}`, "-y"],
    ],
    executable: win32.join(directory, "OpenCode.exe"),
    extractor,
  }
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2))
  assertHost(options.platform)
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const source = await captureCleanSource(root, options.revision)
  const matrix = JSON.parse(
    await readFile(join(root, ".github", "opencode-desktop-assets.json"), "utf8"),
  ) as DesktopAssetMatrix
  validateDesktopAssetMatrix(matrix)
  await requireSourceRevision(root, options.revision)
  const asset = matrix.assets[options.platform]
  validateDesktopAsset(options.platform, asset, matrix.version)

  // Linux AF_UNIX paths must stay under SUN_LEN, so the scratch prefix is short.
  const scratch = await mkdtemp(join(tmpdir(), "occ-"))
  const certificationRoot = join(scratch, "certification")
  const certificationNonce = randomBytes(32).toString("hex")
  const certificationStartedAt = Date.now()
  await mkdir(certificationRoot)
  const debugProfile = process.env.CYCLE_CERT_DEBUG_PROFILE === "1"
  const keepScratch = process.env.CYCLE_CERT_KEEP_SCRATCH === "1"
  if (debugProfile) {
    console.error(`Desktop certification scratch root: ${scratch}`)
  }
  const pluginInput = await archiveFile(options.pluginArchive)
  const nativeInput = await archiveFile(options.nativeArchive)
  const pluginArchive = join(scratch, `plugin-${pluginInput.name}`)
  const nativeArchive = join(scratch, `native-${nativeInput.name}`)
  await Promise.all([
    writeFile(pluginArchive, pluginInput.content, { flag: "wx", mode: 0o600 }),
    writeFile(nativeArchive, nativeInput.content, { flag: "wx", mode: 0o600 }),
  ])
  const pluginPackageSha256 = pluginInput.sha256
  const nativePackageSha256 = nativeInput.sha256
  const certification: DesktopCertificationBinding = {
    nativePackageSha256,
    nonce: certificationNonce,
    pluginPackageSha256,
    revision: options.revision,
    root: certificationRoot,
    startedAtUnixMillis: certificationStartedAt,
  }
  const environment = certificationEnvironment(scratch, options.platform, process.env, certification)
  const assetPath = join(scratch, asset.name)
  let desktopProcess: Bun.Subprocess | undefined
  let desktopProfile: string | undefined
  let windowsProtocol: WindowsProtocolRegistration | undefined
  let mainError: unknown
  try {
    const home = environment.HOME as string
    const userProfile = environment.USERPROFILE ?? home
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(userProfile, { recursive: true }),
      mkdir(join(userProfile, "Documents"), { recursive: true }),
      mkdir(join(userProfile, "Desktop"), { recursive: true }),
      mkdir(join(userProfile, "Downloads"), { recursive: true }),
      mkdir(join(userProfile, "AppData", "Roaming"), { recursive: true }),
      mkdir(join(userProfile, "AppData", "Local"), { recursive: true }),
      mkdir(environment.XDG_CONFIG_HOME as string, { recursive: true }),
      mkdir(environment.XDG_DATA_HOME as string, { recursive: true }),
      mkdir(environment.XDG_STATE_HOME as string, { recursive: true }),
    ])
    await stageDesktopAsset(asset, assetPath, options.desktopAsset)

    const pluginDirectory = join(scratch, "plugin")
    const nativeDirectory = join(scratch, "native")
    await Promise.all([mkdir(pluginDirectory), mkdir(nativeDirectory)])
    await run(["tar", "-xf", pluginArchive, "-C", pluginDirectory], root, environment)
    await run(["tar", "-xf", nativeArchive, "-C", nativeDirectory], root, environment)
    const installedPlugin = join(pluginDirectory, "package")
    const nativeExecutable = join(
      nativeDirectory,
      "package",
      "bin",
      options.platform === "windows-x64" ? "workflowd.exe" : "workflowd",
    )
    if (options.platform !== "windows-x64") await chmod(nativeExecutable, 0o755)
    await run(
      ["bun", "install", "--ignore-scripts", "--production", "--no-save", nativeArchive],
      installedPlugin,
      environment,
    )

    const project = join(scratch, "project")
    const dataDirectory = join(scratch, "workflow-data")
    await mkdir(project)
    await run(["git", "init"], project, environment)
    await run(["git", "config", "user.email", "certification@example.invalid"], project, environment)
    await run(["git", "config", "user.name", "Certification Runner"], project, environment)
    await writeFile(join(project, "README.md"), "# Desktop certification project\n", "utf8")
    await run(["git", "add", "README.md"], project, environment)
    await run(["git", "commit", "-m", "certification fixture"], project, environment)
    const pluginConfig = {
      plugin: [
        [
          pathToFileURL(join(installedPlugin, "dist", "index.js")).href,
          {
            binaryPath: nativeExecutable,
            certification,
            dataDirectory,
            hostVersion: matrix.version,
          },
        ],
      ],
    }
    const configContents = `${JSON.stringify(pluginConfig, null, 2)}\n`
    await writeFile(join(project, "opencode.json"), configContents, "utf8")
    const isolatedConfigDirectories = [
      join(environment.XDG_CONFIG_HOME as string, "opencode"),
      join(environment.HOME as string, ".config", "opencode"),
    ]
    await Promise.all(
      isolatedConfigDirectories.map(async (directory) => {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "opencode.json"), configContents, "utf8")
        await installPackedPluginTree(
          directory,
          installedPlugin,
          nativeExecutable,
          options.platform,
          dataDirectory,
          matrix.version,
          certification,
        )
      }),
    )

    const desktop = await prepareDesktop(options.platform, assetPath, scratch, environment)
    if (options.platform === "windows-x64") {
      windowsProtocol = await captureWindowsProtocolRegistration(scratch, environment)
    }
    const desktopProfileRoots = desktopTestProfileRoots(environment, scratch)
    const existingProfiles = await desktopTestProfiles(desktopProfileRoots)
    const desktopStderr = join(scratch, "desktop.stderr.log")
    const desktopStdout = join(scratch, "desktop.stdout.log")
    desktopProcess = Bun.spawn([...desktop.launch, ...options.launchArguments], {
      cwd: project,
      detached: options.platform !== "windows-x64",
      env: environment,
      stderr: Bun.file(desktopStderr),
      stdout: Bun.file(desktopStdout),
    })
    const launchedDesktop = desktopProcess
    if (options.platform === "linux-x64") {
      desktopProfile = environment.XDG_CONFIG_HOME as string
    } else {
      desktopProfile = await waitForDesktopTestProfile(
        existingProfiles,
        60_000,
        desktopProfileRoots,
        scratch,
      )
      const desktopConfig = join(desktopProfile, "config", "opencode")
      await mkdir(join(desktopProfile, "desktop"), { recursive: true })
      await mkdir(desktopConfig, { recursive: true })
      await Promise.all([
        writeFile(
          join(desktopProfile, "desktop", "opencode.settings"),
          `${JSON.stringify({ firstLaunchOnboardingComplete: true, oldLayoutEligible: false })}\n`,
          "utf8",
        ),
        writeFile(join(desktopConfig, "opencode.json"), configContents, "utf8"),
      ])
      await installPackedPluginTree(
        desktopConfig,
        installedPlugin,
        nativeExecutable,
        options.platform,
        dataDirectory,
        matrix.version,
        certification,
      )
    }
    const withDesktopLogs = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation()
      } catch (error) {
        const stderr = await readFile(desktopStderr, "utf8").catch(() => "")
        const stdout = await readFile(desktopStdout, "utf8").catch(() => "")
        const detail = [stderr.trim(), stdout.trim()].filter((text) => text.length > 0).join("\n")
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(detail.length > 0 ? `${message}\n${detail.slice(-4000)}` : message)
      }
    }
    await withDesktopLogs(() => waitForProcess(launchedDesktop, 2_000))
    const activation = await withDesktopLogs(() =>
      waitForDesktopActivation(certificationRoot, certification, 120_000),
    )

    const evidence = {
      activationCreatedAtUnixMillis: activation.marker.createdAtUnixMillis,
      activationLogSha256: activation.digest,
      activationMarker: PRODUCT_IDENTITY.activationMarker,
      activationNativePackageSha256: activation.marker.nativePackageSha256,
      activationNonce: activation.marker.nonce,
      activationPluginPackageSha256: activation.marker.pluginPackageSha256,
      activationRevision: activation.marker.revision,
      controlPlane: {
        productVersion: activation.marker.health.productVersion,
        protocolVersion: activation.marker.health.protocolVersion,
        schemaMode: activation.marker.health.schemaMode,
        schemaVersion: activation.marker.health.schemaVersion,
      },
      desktop: {
        asset: asset.name,
        authenticity: desktop.authenticity,
        profileIsolation: "fresh-isolated-certification-root",
        sha256: asset.sha256,
        size: asset.size,
        version: matrix.version,
      },
      nativePackageSha256,
      platform: options.platform,
      pluginPackageSha256,
      revision: options.revision,
      schemaVersion: 1,
    }
    await assertSourceUnchanged(root, source, options.revision)
    await mkdir(dirname(resolve(options.output)), { recursive: true })
    await writeFile(resolve(options.output), `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
  } catch (error: unknown) {
    mainError = error
  } finally {
    if (desktopProcess !== undefined) await terminateDesktopProcess(desktopProcess, options.platform)
    if (windowsProtocol !== undefined) {
      await restoreWindowsProtocolRegistration(windowsProtocol, scratch, environment)
    }
    if (desktopProfile !== undefined && !keepScratch) {
      await rm(desktopProfile, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
    }
    if (keepScratch) {
      if (debugProfile) {
        console.error(`Kept scratch root for inspection: ${scratch}`)
      }
    } else {
      await rm(scratch, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
    }
  }
  if (mainError !== undefined) {
    throw mainError as Error
  }
}

async function installPackedPluginTree(
  configDirectory: string,
  packedPlugin: string,
  nativeExecutable: string,
  platform: CertifiedPlatform,
  dataDirectory: string,
  hostVersion: string,
  certification: DesktopCertificationBinding,
): Promise<void> {
  const installRoot = join(configDirectory, "opencode-cycle")
  const nativeBinary = platform === "windows-x64" ? "workflowd.exe" : "workflowd"
  await copyDirectory(packedPlugin, installRoot)
  await mkdir(join(installRoot, "bin"), { recursive: true })
  await copyFile(nativeExecutable, join(installRoot, "bin", nativeBinary))
  if (platform !== "windows-x64") await chmod(join(installRoot, "bin", nativeBinary), 0o755)
  const pluginsDirectory = join(configDirectory, "plugins")
  await mkdir(pluginsDirectory, { recursive: true })
  const loader = `import { fileURLToPath } from "node:url"
import OpenCodeCycle from "../opencode-cycle/dist/index.js"

const binaryPath = fileURLToPath(new URL("../opencode-cycle/bin/${nativeBinary}", import.meta.url))

export default async function OpenCodeCyclePlugin(input) {
  return OpenCodeCycle(input, {
    binaryPath,
    certification: ${JSON.stringify(certification)},
    dataDirectory: ${JSON.stringify(dataDirectory)},
    hostVersion: ${JSON.stringify(hostVersion)},
  })
}
`
  await writeFile(join(pluginsDirectory, "opencode-cycle.js"), loader, "utf8")
}

async function copyDirectory(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) await copyDirectory(source, destination)
    else await copyFile(source, destination)
  }
}

export function parseWindowsProtocolRegistration(output: string): WindowsProtocolRegistration {
  const value = JSON.parse(output) as Record<string, unknown>
  if (typeof value.existed !== "boolean") {
    throw new Error("Windows protocol registration snapshot is malformed")
  }
  if (value.existed && typeof value.command !== "string") {
    throw new Error("Windows protocol registration command is missing")
  }
  return value.existed ? { command: value.command as string, existed: true } : { existed: false }
}

async function captureWindowsProtocolRegistration(
  scratch: string,
  environment: NodeJS.ProcessEnv,
): Promise<WindowsProtocolRegistration> {
  const output = await run(
    [
      windowsPowerShellPath(environment),
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; $path = 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\opencode\\shell\\open\\command'; $snapshot = if (Test-Path -LiteralPath $path) { @{ existed = $true; command = (Get-Item -LiteralPath $path).GetValue('') } } else { @{ existed = $false } }; $snapshot | ConvertTo-Json -Compress",
    ],
    scratch,
    windowsPowerShellEnvironment(environment),
  )
  return parseWindowsProtocolRegistration(output)
}

async function restoreWindowsProtocolRegistration(
  registration: WindowsProtocolRegistration,
  scratch: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const restore = registration.existed
    ? "$ErrorActionPreference = 'Stop'; $path = 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\opencode\\shell\\open\\command'; New-Item -ItemType Directory -Path $path -Force | Out-Null; Set-Item -LiteralPath $path -Value $env:OWF_PROTOCOL_COMMAND"
    : "$ErrorActionPreference = 'Stop'; $path = 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\opencode'; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }"
  await run(
    [windowsPowerShellPath(environment), "-NoProfile", "-NonInteractive", "-Command", restore],
    scratch,
    windowsPowerShellEnvironment({
      ...environment,
      ...(registration.command === undefined ? {} : { OWF_PROTOCOL_COMMAND: registration.command }),
    }),
  )
}

export async function fetchDesktopAsset(
  asset: DesktopAsset,
  destination: string,
  request: (...argumentsList: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
  retryDelayMilliseconds = 1_000,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await rm(destination, { force: true })
    try {
      const response = await request(asset.url, { redirect: "follow" })
      if (!response.ok || response.body === null) {
        throw new Error(`Desktop download failed: HTTP ${response.status}`)
      }
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      )
      await verifyDesktopAssetFile(asset, destination)
      return
    } catch (error) {
      await rm(destination, { force: true })
      if (attempt === 3) throw error
      await Bun.sleep(retryDelayMilliseconds * attempt)
    }
  }
}

export async function stageDesktopAsset(
  asset: DesktopAsset,
  destination: string,
  source?: string,
): Promise<void> {
  if (source === undefined) return fetchDesktopAsset(asset, destination)
  const verified = await readVerifiedRegularFile(source, { maxBytes: asset.size })
  await writeFile(destination, verified.content, { flag: "wx", mode: 0o600 })
  await verifyDesktopAssetFile(asset, destination)
}

async function verifyDesktopAssetFile(asset: DesktopAsset, path: string): Promise<void> {
  const verified = await readVerifiedRegularFile(path, { maxBytes: asset.size })
  if (verified.size !== asset.size) {
    throw new Error("Desktop asset size does not match the certified release")
  }
  if (verified.sha256 !== asset.sha256) {
    throw new Error("Desktop asset digest does not match the certified release")
  }
}

async function prepareDesktop(
  platform: CertifiedPlatform,
  asset: string,
  scratch: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ authenticity: DesktopAuthenticity; launch: string[] }> {
  if (platform === "windows-x64") {
    const signature = await run(
      [
        windowsPowerShellPath(environment),
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Security; $value = Get-AuthenticodeSignature -LiteralPath $env:OWF_CERT_ASSET; if ($value.Status -ne 'Valid') { throw \"Invalid Authenticode status: $($value.Status)\" }; if ($null -eq $value.SignerCertificate) { throw 'Authenticode signer certificate is missing' }; $value.SignerCertificate.Subject",
      ],
      scratch,
      windowsPowerShellEnvironment({ ...environment, OWF_CERT_ASSET: asset }),
    )
    const extraction = windowsDesktopExtraction(asset, scratch, environment)
    if (!(await exists(extraction.extractor))) {
      throw new Error("Windows Desktop certification requires 7-Zip")
    }
    for (const command of extraction.commands) await run(command, scratch, environment)
    if (!(await exists(extraction.executable))) {
      throw new Error("OpenCode Desktop extraction did not create OpenCode.exe")
    }
    const applicationSignature = await run(
      [
        windowsPowerShellPath(environment),
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Security; $value = Get-AuthenticodeSignature -LiteralPath $env:OWF_CERT_ASSET; if ($value.Status -ne 'Valid') { throw \"Invalid Authenticode status: $($value.Status)\" }; if ($null -eq $value.SignerCertificate) { throw 'Authenticode signer certificate is missing' }; $value.SignerCertificate.Subject",
      ],
      scratch,
      windowsPowerShellEnvironment({ ...environment, OWF_CERT_ASSET: extraction.executable }),
    )
    const installerSigner = signature.trim()
    const applicationSigner = applicationSignature.trim()
    if (installerSigner.length === 0 || applicationSigner.length === 0) {
      throw new Error("Windows Desktop Authenticode signer subject is empty")
    }
    return {
      authenticity: {
        applicationSigner,
        installerSigner,
        method: "authenticode",
        status: "verified",
      },
      launch: [extraction.executable],
    }
  }
  if (platform === "linux-x64") {
    await chmod(asset, 0o755)
    await run([asset, "--appimage-extract"], scratch, environment)
    const appRun = join(scratch, "squashfs-root", "AppRun")
    if (!(await exists(appRun))) throw new Error("OpenCode Desktop AppImage extraction failed")
    const launchArguments = ["xvfb-run", "-a", appRun, "--disable-gpu"]
    if (process.getuid?.() === 0) {
      launchArguments.push("--no-sandbox")
    }
    return {
      authenticity: { method: "sha256", status: "verified" },
      launch: launchArguments,
    }
  }
  throw new Error(`Unsupported Desktop certification platform: ${platform}`)
}

export function activationScanRoots(
  dataDirectory: string,
  _desktopProfile: string,
  _environment: NodeJS.ProcessEnv,
): readonly string[] {
  return [dataDirectory]
}

export async function waitForDesktopActivation(
  root: string,
  binding: DesktopCertificationBinding,
  timeout: number,
  dependencies: { readonly now?: () => number; readonly sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<{ digest: string; marker: DesktopActivationMarker }> {
  if (resolve(root) !== binding.root) {
    throw new Error("Desktop activation root does not match the certification binding")
  }
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? Bun.sleep
  const deadline = now() + timeout
  const path = join(root, "desktop-activation.json")
  while (now() < deadline) {
    const present = await lstat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (present) {
      const file = await readVerifiedRegularFile(path, { maxBytes: 64 * 1024, root })
      const marker = parseDesktopActivationMarker(JSON.parse(file.content.toString("utf8")) as unknown)
      if (
        marker.nonce !== binding.nonce ||
        marker.revision !== binding.revision ||
        marker.pluginPackageSha256 !== binding.pluginPackageSha256 ||
        marker.nativePackageSha256 !== binding.nativePackageSha256
      ) {
        throw new Error("Desktop activation marker does not match the run nonce, revision and packages")
      }
      if (
        marker.createdAtUnixMillis < binding.startedAtUnixMillis ||
        marker.createdAtUnixMillis > now() + 5_000
      ) {
        throw new Error("Desktop activation marker time is outside the isolated certification run")
      }
      return { digest: file.sha256, marker }
    }
    await sleep(1_000)
  }
  throw new Error("OpenCode Desktop did not activate the installed Cycle plugin")
}

const DESKTOP_TEST_PROFILE_PREFIXES = ["opencode-onboarding-", "opencode-"]
const DESKTOP_PROFILE_MARKER_FILES = [
  ["desktop", "opencode.settings"],
  ["config", "opencode", "opencode.json"],
  ["state", "state.json"],
  ["data", "state.json"],
  ["config", "opencode.json"],
  [".config", "opencode", "opencode.json"],
  [".local", "share", "opencode", "state.json"],
  [".local", "share", "opencode-cycle", "state.json"],
] as const

export function desktopTestProfileRoots(
  environment: NodeJS.ProcessEnv = {},
  scratchRoot?: string,
): readonly string[] {
  return [
    scratchRoot,
    tmpdir(),
    "/tmp",
    "/var/tmp",
    environment.HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    environment.LOCALAPPDATA,
    environment.APPDATA,
  ].filter((path): path is string => typeof path === "string" && path.length > 0)
}

export async function desktopTestProfiles(roots: readonly string[] = [tmpdir()]): Promise<Set<string>> {
  const locations = new Set<string>()
  for (const root of roots) {
    const base = resolve(root)
    const discovered = await discoverProfileRoots(base)
    for (const entry of discovered) {
      locations.add(entry)
    }
  }
  return locations
}

async function discoverProfileRoots(
  root: string,
  depth = 5,
  visited = new Set<string>(),
): Promise<string[]> {
  if (depth < 0) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const candidateEntries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const candidate = join(root, entry.name)
        if (visited.has(candidate)) return []
        visited.add(candidate)
        if (
          DESKTOP_TEST_PROFILE_PREFIXES.some((prefix) => entry.name.startsWith(prefix)) &&
          (await isLikelyProfileDirectory(candidate))
        ) {
          return [candidate]
        }
        if (await isLikelyProfileDirectory(candidate)) return [candidate]
        if (depth > 0) return discoverProfileRoots(candidate, depth - 1, visited)
        return []
      }),
  )
  return [...candidateEntries].flat()
}

export function isDesktopHarnessPath(path: string, scratch: string): boolean {
  const resolved = resolve(path)
  const root = resolve(scratch)
  if (resolved === root) return true
  const rel = relative(root, resolved)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`)
}

function isDesktopTestProfileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith("opencode-cycle-")) return false
  return lower === "opencode" || DESKTOP_TEST_PROFILE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

async function waitForDesktopTestProfile(
  existing: ReadonlySet<string>,
  timeout: number,
  roots: readonly string[] = [tmpdir()],
  scratch?: string,
): Promise<string> {
  const debugProfile = process.env.CYCLE_CERT_DEBUG_PROFILE === "1"
  const deadline = Date.now() + timeout
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    for (const profile of await desktopTestProfiles(roots)) {
      if (existing.has(profile)) continue
      if (scratch !== undefined && isDesktopHarnessPath(profile, scratch)) continue
      return profile
    }
    const observed: string[] = []
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const candidate = join(root, entry.name)
        if (entry.isDirectory() && !existing.has(candidate)) {
          if (scratch !== undefined && isDesktopHarnessPath(candidate, scratch)) continue
          observed.push(candidate)
          if (isDesktopTestProfileName(entry.name)) return candidate
          const discovered = await discoverProfileRoots(candidate, 3)
          const fallback = discovered.find(
            (path) => scratch === undefined || !isDesktopHarnessPath(path, scratch),
          )
          if (fallback !== undefined) return fallback
        }
      }
    }
    if (debugProfile) {
      console.error(`waitForDesktopTestProfile attempt ${attempts}: observed candidates ${JSON.stringify(observed)}`)
    }
    await Bun.sleep(25)
  }
  throw new Error("OpenCode Desktop did not create its isolated test profile")
}

async function isLikelyProfileDirectory(path: string): Promise<boolean> {
  for (const marker of DESKTOP_PROFILE_MARKER_FILES) {
    const candidate = marker.reduce((value, segment) => join(value, segment), path)
    if (await exists(candidate)) return true
  }
  return false
}

async function waitForProcess(process: Bun.Subprocess, duration: number): Promise<void> {
  const exited = await Promise.race([process.exited.then(() => true), Bun.sleep(duration).then(() => false)])
  if (exited) throw new Error("OpenCode Desktop exited before project activation")
}

export async function terminateDesktopProcess(
  child: Bun.Subprocess,
  platform: CertifiedPlatform,
): Promise<void> {
  if (platform === "windows-x64") {
    child.kill()
    await Promise.race([child.exited, Bun.sleep(5_000)])
    return
  }
  signalProcessGroup(child.pid, "SIGTERM")
  await Promise.race([child.exited, Bun.sleep(5_000)])
  signalProcessGroup(child.pid, "SIGKILL")
  await Bun.sleep(25)
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function run(command: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const platformPath = process.platform === "linux"
    ? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    : ""
  const pathSegments = [
    environment.PATH,
    platformPath,
  ].flatMap((value) =>
    typeof value === "string" && value.trim().length > 0
      ? value.split(process.platform === "win32" ? ";" : ":")
      : [],
  )
  const dedupedPath = [...new Set(pathSegments.filter(Boolean))]
  const commandEnvironment = {
    ...environment,
    PATH: dedupedPath.join(process.platform === "win32" ? ";" : ":"),
  }
  const childProcess = Bun.spawn([...command], { cwd, env: commandEnvironment, stderr: "inherit", stdout: "pipe" })
  const output = await new Response(childProcess.stdout).text()
  if ((await childProcess.exited) !== 0) throw new Error(`${command[0]} failed`)
  return output
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function archiveFile(path: string): Promise<VerifiedFile> {
  const resolved = resolve(path)
  const details = await lstat(resolved)
  if (details.isSymbolicLink()) throw new Error(`Package archive path must not be a link: ${path}`)
  if (details.isFile() && resolved.endsWith(".tgz")) {
    return readVerifiedRegularFile(resolved)
  }
  if (!details.isDirectory()) throw new Error(`Package archive path is invalid: ${path}`)
  const files = await readVerifiedFileDirectory(resolved)
  if (files.length !== 1 || !files[0]?.name.endsWith(".tgz")) {
    throw new Error(`Expected exactly one direct package archive and no extra material in ${path}`)
  }
  return files[0]
}

function assertHost(platform: CertifiedPlatform): void {
  const expected = {
    "linux-x64": ["linux", "x64"],
    "windows-x64": ["win32", "x64"],
  }[platform]
  if (process.platform !== expected[0] || process.arch !== expected[1]) {
    throw new Error(`${platform} certification must run on its native host`)
  }
}

function parseArguments(argumentsList: readonly string[]): {
  desktopAsset?: string
  launchArguments: string[]
  nativeArchive: string
  output: string
  platform: CertifiedPlatform
  pluginArchive: string
  revision: string
} {
  const values = new Map<string, string>()
  const launchArguments: string[] = []
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index]
    const value = argumentsList[index + 1]
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Desktop certification arguments must be --key value pairs")
    }
    if (key === "--launch-argument") launchArguments.push(value)
    else values.set(key.slice(2), value)
  }
  const platform = values.get("platform") as CertifiedPlatform
  if (!(SUPPORTED_DESKTOP_CERTIFICATION_PLATFORMS as readonly string[]).includes(platform)) {
    throw new Error("Desktop certification requires a supported --platform")
  }
  for (const key of ["native-archive", "output", "plugin-archive", "revision"]) {
    if (!values.has(key)) throw new Error(`Desktop certification is missing --${key}`)
  }
  return {
    ...(values.has("desktop-asset") ? { desktopAsset: values.get("desktop-asset") as string } : {}),
    launchArguments,
    nativeArchive: values.get("native-archive") as string,
    output: values.get("output") as string,
    platform,
    pluginArchive: values.get("plugin-archive") as string,
    revision: values.get("revision") as string,
  }
}

if (import.meta.main) await main()
