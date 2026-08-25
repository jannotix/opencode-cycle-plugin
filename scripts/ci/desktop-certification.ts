import { createHash, randomBytes } from "node:crypto"
import { spawn as spawnChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  desktopCertificationBindingDigest,
  desktopCertificationProcessToken,
  parseDesktopActivationMarker,
  type DesktopActivationMarker,
  type DesktopCertificationBinding,
  type DesktopDaemonIdentity,
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
import { prepareReceiptOutput, publishReceiptAtomically } from "./receipt-output.js"
import { cleanupCertifiedDaemon, type CertifiedDaemonCleanup } from "./certified-daemon.js"
import {
  openDesktopDependencyTreeVerification,
  verifyDesktopDependencyTree,
  type DesktopDependencyTreeReceipt,
} from "./desktop-dependency-tree.js"

export { openDesktopDependencyTreeVerification, verifyDesktopDependencyTree }

import {
  bundledDesktopRuntimeLinker,
  type DesktopRuntimeLinkerExpected,
} from "./desktop-runtime-linker.js"


export interface DesktopAsset {
  readonly name: string
  readonly runtimeExecutable: {
    readonly name: string
    readonly productVersion: string
    readonly sha256: string
  }
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

const DESKTOP_LOAD_DIAGNOSTIC_FILE = "desktop-load-diagnostics.jsonl"
const DESKTOP_RUNTIME_GUARD_DIAGNOSTIC_FILE = "desktop-runtime-guard-diagnostics.jsonl"
const DESKTOP_RUNTIME_GUARD_FILE_PREFIX = "desktop-runtime-guard-"
const DESKTOP_RUNTIME_GUARD_TYPE = "opencode-cycle-desktop-runtime-guard"
const DESKTOP_RUNTIME_GUARD_ENV = "CYCLE_DESKTOP_RUNTIME_GUARD"
const OFFICIAL_DESKTOP_RUNTIME = {
  electronVersion: "42.3.3",
  nodeVersion: "24.15.0",
} as const
const DESKTOP_LOAD_DIAGNOSTIC_TYPE = "opencode-cycle-desktop-load-diagnostic"
const DESKTOP_LOAD_DIAGNOSTIC_STAGES = [
  "certification_env_prepared",
  "config_tree_prepared",
  "config_path_discovered",
  "plugin_specifier_resolved",
  "effective_env_validated",
  "candidate_module_resolved",
  "plugin_entry_started",
  "plugin_entry_completed",
  "daemon_identity_published",
  "activation_marker_verified",
  "daemon_cleanup_verified",
] as const
type DesktopLoadDiagnosticStage = typeof DESKTOP_LOAD_DIAGNOSTIC_STAGES[number]
const DESKTOP_LOAD_DIAGNOSTIC_FAILURE_STATUSES = [
  "config_root_failed",
  "dependency_resolution_failed",
  "export_mismatch",
  "failed",
  "module_load_failed",
  "module_not_found",
  "shell_or_config_root_failed",
] as const
type DesktopLoadDiagnosticFailureStatus = typeof DESKTOP_LOAD_DIAGNOSTIC_FAILURE_STATUSES[number]
type DesktopLoadDiagnosticStatus = DesktopLoadDiagnosticFailureStatus | "passed"

interface DesktopLoadDiagnostic {
  readonly runDigest: string
  readonly schemaVersion: 2
  readonly sequence: number
  readonly stage: DesktopLoadDiagnosticStage
  readonly status: DesktopLoadDiagnosticStatus
  readonly type: typeof DESKTOP_LOAD_DIAGNOSTIC_TYPE
}

export interface PreparedDesktopCertificationLoad {
  readonly configDirectory: string
  readonly configFile: string
  readonly dependencyTree: DesktopDependencyTreeReceipt
  readonly diagnosticsFile: string
  readonly installedPlugin: string
  readonly pluginLoader: string
  readonly runtimeGuardDiagnosticsFile: string
  readonly shellWrapper?: string
}

export interface DesktopModuleRuntimeReceipt {
  readonly bindingDigest: string
  readonly candidateDefaultExportLinked: true
  readonly candidateEntrySha256: string
  readonly candidateEvaluated: false
  readonly dependencyFileCount: number
  readonly dependencyPackageCount: number
  readonly dependencyTotalBytes: number
  readonly dependencyTreeSha256: string
  readonly unsafeDynamicImportsRejected: true
  readonly electronVersion: string
  readonly graphFileCount: number
  readonly graphSha256: string
  readonly linkedEsmModuleCount: number
  readonly linkerSha256: string
  readonly loaderSha256: string
  readonly moduleLinked: true
  readonly nativePackageSha256: string
  readonly nodeVersion: string
  readonly pluginPackageSha256: string
  readonly productVersion: string
  readonly revision: string
  readonly runtimeExecutableSha256: string
  readonly runtimeProductVersion: string
  readonly schemaVersion: 4
  readonly suppressedOptionalRootCount: number
  readonly type: typeof DESKTOP_RUNTIME_GUARD_TYPE
  readonly unsafeModuleLoadingRejected: true
  readonly verifiedAssetFileCount: number
  readonly verifiedCommonJsModuleCount: number
  readonly verifiedContentTreeSha256: string
  readonly verifiedJsonModuleCount: number
}

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
  if (
    asset.runtimeExecutable.name.length === 0 ||
    asset.runtimeExecutable.productVersion.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(asset.runtimeExecutable.sha256)
  ) throw new Error(`${platform} Desktop runtime executable metadata is invalid`)
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
      JSON.stringify(matrix.assets[platform].runtimeExecutable) !==
        JSON.stringify(expected.runtimeExecutable) ||
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
  const configDirectory = join(isolated, "opencode-config")
  const taskTemp = join(isolated, "temp")
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
    OPENCODE_CONFIG: join(configDirectory, "opencode.json"),
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_TEST_HOME: join(isolated, "home"),
    TEMP: taskTemp,
    TMP: taskTemp,
    TMPDIR: taskTemp,
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
    ...(platform === "windows-x64"
      ? { OPENCODE_TEST_ONBOARDING: "1" }
      : { SHELL: join(isolated, "nu") }),
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
  const receiptOutput = await prepareReceiptOutput(root, options.output, {
    basename: `${options.platform}.json`,
    lane: ["desktop"],
  })
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
  let preparedLoad: PreparedDesktopCertificationLoad | undefined
  let receiptEvidence: Record<string, unknown> | undefined
  let moduleRuntimeEvidence: DesktopModuleRuntimeReceipt | undefined
  let activationDaemon: DesktopDaemonIdentity | undefined
  let daemonCleanup: CertifiedDaemonCleanup | undefined
  let loadDiagnosticsEvidence: { readonly bytes: number; readonly sha256: string } | undefined
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
      mkdir(join(environment.XDG_CONFIG_HOME as string, "opencode"), { recursive: true }),
      mkdir(environment.XDG_DATA_HOME as string, { recursive: true }),
      mkdir(environment.XDG_STATE_HOME as string, { recursive: true }),
      mkdir(environment.TMPDIR as string, { recursive: true }),
      mkdir(join(environment.OPENCODE_TEST_HOME as string, ".opencode"), { recursive: true }),
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
      ["bun", "install", "--backend=copyfile", "--ignore-scripts", "--linker=hoisted", "--production", "--no-save", nativeArchive],
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
    preparedLoad = await prepareDesktopCertificationLoad({
      certification,
      dataDirectory,
      environment,
      hostVersion: matrix.version,
      nativeExecutable,
      packedPlugin: installedPlugin,
      platform: options.platform,
      scratch,
    })

    const desktop = await prepareDesktop(options.platform, assetPath, scratch, environment)
    moduleRuntimeEvidence = await verifyDesktopModuleRuntime({
      binding: certification,
      cwd: project,
      environment,
      hostVersion: matrix.version,
      platform: options.platform,
      prepared: preparedLoad,
      runtimeCommand: desktop.moduleRuntimeCommand,
      scratch,
    })
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
      await mkdir(join(desktopProfile, "desktop"), { recursive: true })
      await writeFile(
        join(desktopProfile, "desktop", "opencode.settings"),
        `${JSON.stringify({ firstLaunchOnboardingComplete: true, oldLayoutEligible: false })}\n`,
        "utf8",
      )
    }
    const withDesktopLogs = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation()
      } catch (error) {
        const output = await desktopOutputSummary(
          desktopStdout,
          desktopStderr,
          scratch,
        ).catch(() => "desktop_output=invalid")
        throw new Error(`${sanitizeDesktopFailure(error)}; ${output}`)
      }
    }
    await withDesktopLogs(() => waitForProcess(launchedDesktop, 2_000))
    const activation = await withDesktopLogs(() =>
      waitForDesktopActivation(certificationRoot, certification, 120_000),
    )
    activationDaemon = activation.marker.daemon

    receiptEvidence = {
      activationCreatedAtUnixMillis: activation.marker.createdAtUnixMillis,
      activationLogSha256: activation.digest,
      activationMarker: PRODUCT_IDENTITY.activationMarker,
      activationNativePackageSha256: activation.marker.nativePackageSha256,
      activationNonce: activation.marker.nonce,
      activationPluginPackageSha256: activation.marker.pluginPackageSha256,
      activationRevision: activation.marker.revision,
      activationRunDigest: activation.marker.runDigest,
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
      moduleRuntime: moduleRuntimeEvidence,
      nativePackageSha256,
      platform: options.platform,
      pluginPackageSha256,
      revision: options.revision,
      schemaVersion: 1,
    }
  } catch (error: unknown) {
    mainError = error
  } finally {
    const preparedForCleanup = preparedLoad
    const processCleanup = await cleanupDesktopCertificationProcesses({
      ...(preparedForCleanup === undefined
        ? {}
        : {
            cleanupDaemon: () => cleanupCertifiedDaemon({
              binding: certification,
              dataDirectory: join(scratch, "workflow-data"),
              expectedBinaryPath: join(
                preparedForCleanup.installedPlugin,
                "bin",
                options.platform === "windows-x64" ? "workflowd.exe" : "workflowd",
              ),
              ...(activationDaemon === undefined ? {} : { expectedDaemon: activationDaemon }),
              platform: options.platform,
            }),
          }),
      ...(desktopProcess === undefined ? {} : { desktopProcess }),
      existingError: mainError,
      platform: options.platform,
    })
    mainError = processCleanup.error
    daemonCleanup = processCleanup.daemonCleanup
    if (preparedLoad !== undefined) {
      if (daemonCleanup !== undefined && receiptEvidence !== undefined) {
        try {
          if (
            !daemonCleanup.markerPublished ||
            !daemonCleanup.exitMarkerPublished ||
            !daemonCleanup.processAbsent ||
            !daemonCleanup.shutdownAuthenticated ||
            !daemonCleanup.terminated
          ) throw new Error("Successful Desktop certification did not complete authenticated daemon cleanup")
          await completeDesktopDaemonCleanupDiagnostic(
            preparedLoad.diagnosticsFile,
            certification,
            "passed",
          )
          const diagnostics = await readVerifiedRegularFile(preparedLoad.diagnosticsFile, {
            maxBytes: 64 * 1024,
            root: certification.root,
          })
          loadDiagnosticsEvidence = {
            bytes: diagnostics.content.length,
            sha256: diagnostics.sha256,
          }
        } catch (error) {
          await completeDesktopDaemonCleanupDiagnostic(
            preparedLoad.diagnosticsFile,
            certification,
            "failed",
          ).catch(() => undefined)
          mainError = combineCertificationErrors(
            mainError,
            error,
            "Desktop certification daemon evidence failed",
          )
        }
      } else if (daemonCleanup === undefined) {
        await completeDesktopDaemonCleanupDiagnostic(
          preparedLoad.diagnosticsFile,
          certification,
          "failed",
        ).catch(() => undefined)
      }
    }
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
  if (
    receiptEvidence === undefined ||
    daemonCleanup === undefined ||
    loadDiagnosticsEvidence === undefined
  ) {
    throw new Error("Desktop certification completed without cleanup-bound receipt evidence")
  }
  receiptEvidence.daemon = {
    binaryPathSha256: daemonCleanup.binaryPathSha256,
    exitMarkerPublished: daemonCleanup.exitMarkerPublished,
    markerPublished: daemonCleanup.markerPublished,
    parentPid: daemonCleanup.parentPid,
    parentStartTimeUnixMillis: daemonCleanup.parentStartTimeUnixMillis,
    pid: daemonCleanup.pid,
    processAbsent: daemonCleanup.processAbsent,
    processStartTimeUnixMillis: daemonCleanup.processStartTimeUnixMillis,
    runDigest: daemonCleanup.runDigest,
    shutdownAuthenticated: daemonCleanup.shutdownAuthenticated,
    startedAtUnixMillis: daemonCleanup.startedAtUnixMillis,
    startTokenSha256: daemonCleanup.startTokenSha256,
    terminated: daemonCleanup.terminated,
  }
  receiptEvidence.loadDiagnostics = loadDiagnosticsEvidence
  await publishReceiptAtomically(
    receiptOutput,
    Buffer.from(`${JSON.stringify(receiptEvidence, null, 2)}\n`),
    () => assertSourceUnchanged(root, source, options.revision),
  )
}

export async function desktopOutputSummary(
  stdout: string,
  stderr: string,
  root: string,
): Promise<string> {
  const values = await Promise.all(
    [["stdout", stdout], ["stderr", stderr]].map(async ([label, path]) => {
      const file = await readVerifiedRegularFile(path as string, { maxBytes: 4 * 1024 * 1024, root })
      return `${label}_bytes=${file.content.length},${label}_sha256=${file.sha256}`
    }),
  )
  return values.join(",")
}

function sanitizeDesktopFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (message === "OpenCode Desktop exited before project activation") return message
  if (
    /^OpenCode Desktop did not activate the installed Cycle plugin; Desktop load diagnostics: [a-z_=, ]+$/u.test(message)
  ) return message
  return "OpenCode Desktop certification failed"
}

function combineCertificationErrors(existing: unknown, next: unknown, message: string): unknown {
  return existing === undefined ? next : new AggregateError([existing, next], message)
}

export async function cleanupDesktopCertificationProcesses(input: {
  readonly cleanupDaemon?: () => Promise<CertifiedDaemonCleanup>
  readonly desktopProcess?: Bun.Subprocess
  readonly existingError: unknown
  readonly platform: CertifiedPlatform
  readonly terminateDesktop?: (process: Bun.Subprocess, platform: CertifiedPlatform) => Promise<void>
}): Promise<{ readonly daemonCleanup?: CertifiedDaemonCleanup; readonly error: unknown }> {
  let error = input.existingError
  let daemonCleanup: CertifiedDaemonCleanup | undefined
  if (input.cleanupDaemon !== undefined) {
    try {
      daemonCleanup = await input.cleanupDaemon()
    } catch (cleanupError) {
      error = combineCertificationErrors(error, cleanupError, "Desktop daemon cleanup failed")
    }
  }
  if (input.desktopProcess !== undefined) {
    try {
      await (input.terminateDesktop ?? terminateDesktopProcess)(input.desktopProcess, input.platform)
    } catch (desktopError) {
      error = combineCertificationErrors(error, desktopError, "Desktop process cleanup failed")
    }
  }
  return {
    ...(daemonCleanup === undefined ? {} : { daemonCleanup }),
    error,
  }
}

export async function prepareDesktopCertificationLoad(input: {
  readonly certification: DesktopCertificationBinding
  readonly dataDirectory: string
  readonly environment: NodeJS.ProcessEnv
  readonly hostVersion: string
  readonly nativeExecutable: string
  readonly packedPlugin: string
  readonly platform: CertifiedPlatform
  readonly scratch: string
}): Promise<PreparedDesktopCertificationLoad> {
  const certificationRoot = resolve(input.certification.root)
  if (!isDesktopHarnessPath(certificationRoot, input.scratch)) {
    throw new Error("Desktop certification evidence root is outside the isolated scratch")
  }
  const certificationRootDetails = await lstat(certificationRoot)
  if (!certificationRootDetails.isDirectory() || certificationRootDetails.isSymbolicLink()) {
    throw new Error("Desktop certification evidence root must be a real directory")
  }
  if (await realpath(certificationRoot) !== certificationRoot || certificationRoot !== input.certification.root) {
    throw new Error("Desktop certification evidence root must not be a link or alias")
  }
  const diagnosticsFile = join(certificationRoot, DESKTOP_LOAD_DIAGNOSTIC_FILE)
  const runtimeGuardDiagnosticsFile = join(
    certificationRoot,
    DESKTOP_RUNTIME_GUARD_DIAGNOSTIC_FILE,
  )
  const preparedDiagnostics = await createPreparedDesktopDiagnostics(
    [diagnosticsFile, runtimeGuardDiagnosticsFile],
    input.certification,
  )

  try {
    assertCertificationEnvironmentBinding(input.scratch, input.environment, input.certification)
  } catch (error) {
    try {
      await preparedDiagnostics.append("certification_env_prepared", "failed")
    } finally {
      await preparedDiagnostics.close()
    }
    throw error
  }
  await preparedDiagnostics.append("certification_env_prepared", "passed")

  let shellWrapper: string | undefined
  let prepared: Omit<
    PreparedDesktopCertificationLoad,
    "diagnosticsFile" | "runtimeGuardDiagnosticsFile" | "shellWrapper"
  >
  try {
    if (input.platform === "linux-x64") {
      shellWrapper = input.environment.SHELL as string
      await writeFile(shellWrapper, certificationShellGuardSource(), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o700,
      })
      await chmod(shellWrapper, 0o700)
    }
    prepared = await installPackedPluginTree(
      input.environment.OPENCODE_CONFIG_DIR as string,
      input.packedPlugin,
      input.nativeExecutable,
      input.platform,
      input.dataDirectory,
      input.hostVersion,
      input.certification,
      diagnosticsFile,
      runtimeGuardDiagnosticsFile,
      input.scratch,
      input.environment,
    )
  } catch (error) {
    try {
      await preparedDiagnostics.append("config_tree_prepared", "failed")
    } finally {
      await preparedDiagnostics.close()
    }
    throw error
  }
  await preparedDiagnostics.append("config_tree_prepared", "passed")
  await preparedDiagnostics.close()
  return {
    ...prepared,
    diagnosticsFile,
    runtimeGuardDiagnosticsFile,
    ...(shellWrapper === undefined ? {} : { shellWrapper }),
  }
}

async function createPreparedDesktopDiagnostics(
  paths: readonly string[],
  binding: DesktopCertificationBinding,
): Promise<{
  append(stage: DesktopLoadDiagnosticStage, status: DesktopLoadDiagnosticStatus): Promise<void>
  close(): Promise<void>
}> {
  const handles: FileHandle[] = []
  try {
    for (const path of paths) handles.push(await open(path, "wx", 0o600))
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)))
    throw error
  }
  let sequence = 0
  let terminal = false
  let closed = false
  return {
    async append(stage, status) {
      if (
        closed || terminal ||
        DESKTOP_LOAD_DIAGNOSTIC_STAGES[sequence] !== stage ||
        (status !== "passed" && !DESKTOP_LOAD_DIAGNOSTIC_FAILURE_STATUSES.includes(
          status as DesktopLoadDiagnosticFailureStatus,
        ))
      ) throw new Error("Desktop load diagnostic transcript transition is invalid")
      const line = `${JSON.stringify({
        runDigest: desktopCertificationBindingDigest(binding),
        schemaVersion: 2,
        sequence,
        stage,
        status,
        type: DESKTOP_LOAD_DIAGNOSTIC_TYPE,
      })}\n`
      await Promise.all(handles.map(async (handle) => {
        await handle.writeFile(line, "utf8")
        await handle.sync()
      }))
      sequence += 1
      terminal = status !== "passed"
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.all(handles.map((handle) => handle.close()))
    },
  }
}

function assertCertificationEnvironmentBinding(
  scratch: string,
  environment: NodeJS.ProcessEnv,
  certification: DesktopCertificationBinding,
): void {
  const root = resolve(scratch)
  const configDirectory = join(root, "opencode-config")
  if (!isDesktopHarnessPath(certification.root, root)) {
    throw new Error("Desktop certification evidence root is outside the isolated scratch")
  }
  if (
    environment.OPENCODE_CONFIG_DIR !== configDirectory ||
    environment.OPENCODE_CONFIG !== join(configDirectory, "opencode.json")
  ) {
    throw new Error("Desktop certification config binding is invalid")
  }
  if (
    environment.CYCLE_CERTIFICATION_NONCE !== certification.nonce ||
    environment.CYCLE_CERTIFICATION_ROOT !== certification.root
  ) {
    throw new Error("Desktop certification marker authority is not bound to the environment")
  }
  if (environment.OPENCODE_DISABLE_PROJECT_CONFIG !== "true") {
    throw new Error("Desktop certification must disable ambient project configuration")
  }
  const ownedPaths = [
    environment.HOME,
    environment.OPENCODE_TEST_HOME,
    environment.TEMP,
    environment.TMP,
    environment.TMPDIR,
    environment.XDG_CACHE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    ...(environment.OPENCODE_TEST_ONBOARDING === "1" ? [] : [environment.SHELL]),
  ]
  if (ownedPaths.some((path) => typeof path !== "string" || !isDesktopHarnessPath(path, root))) {
    throw new Error("Desktop certification environment contains a path outside the isolated scratch")
  }
}

function certificationShellGuardSource(): string {
  return "#!/bin/sh\nexit 1\n"
}

async function installPackedPluginTree(
  configDirectory: string,
  packedPlugin: string,
  nativeExecutable: string,
  platform: CertifiedPlatform,
  dataDirectory: string,
  hostVersion: string,
  certification: DesktopCertificationBinding,
  diagnosticsFile: string,
  runtimeGuardDiagnosticsFile: string,
  scratch: string,
  environment: NodeJS.ProcessEnv,
): Promise<Omit<
  PreparedDesktopCertificationLoad,
  "diagnosticsFile" | "runtimeGuardDiagnosticsFile" | "shellWrapper"
>> {
  const installRoot = join(configDirectory, "opencode-cycle")
  const nativeBinary = platform === "windows-x64" ? "workflowd.exe" : "workflowd"
  await mkdir(configDirectory, { recursive: true })
  await copyDirectory(packedPlugin, installRoot)
  await mkdir(join(installRoot, "bin"), { recursive: true })
  await copyFile(nativeExecutable, join(installRoot, "bin", nativeBinary))
  if (platform !== "windows-x64") await chmod(join(installRoot, "bin", nativeBinary), 0o755)
  const certificationDirectory = join(configDirectory, "cycle-certification")
  const pluginLoader = join(certificationDirectory, "opencode-cycle-loader.js")
  await mkdir(certificationDirectory, { recursive: true })
  const pluginOptions = {
    binaryPath: join(installRoot, "bin", nativeBinary),
    certification,
    dataDirectory,
    hostVersion,
  }
  const diagnosticWriter = desktopLoadDiagnosticWriterSource(
    diagnosticsFile,
    runtimeGuardDiagnosticsFile,
    certification,
  )
  const effectiveEnvironmentValidator = desktopEffectiveEnvironmentValidatorSource(
    scratch,
    configDirectory,
    join(configDirectory, "opencode.json"),
    environmentBindingsForLoader(environment),
  )
  const loader = `import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

${diagnosticWriter}
${effectiveEnvironmentValidator}

recordDesktopLoadDiagnostic("config_path_discovered", "passed")
recordDesktopLoadDiagnostic("plugin_specifier_resolved", "passed")

try {
  validateDesktopEffectiveEnvironment()
} catch {
  recordDesktopLoadDiagnostic("effective_env_validated", "config_root_failed")
  throw new Error("Cycle certification effective environment is invalid")
}
recordDesktopLoadDiagnostic("effective_env_validated", "passed")

let candidatePackage
try {
  candidatePackage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../opencode-cycle/package.json", import.meta.url)), "utf8"),
  )
} catch {
  recordDesktopLoadDiagnostic("candidate_module_resolved", "module_not_found")
  throw new Error("Cycle candidate module resolution failed")
}
const candidateExport = candidatePackage?.exports?.["."]
if (candidateExport !== "./dist/index.js") {
  recordDesktopLoadDiagnostic("candidate_module_resolved", "export_mismatch")
  throw new Error("Cycle candidate module resolution failed")
}
const candidateEntry = new URL("../opencode-cycle/" + candidateExport.slice(2), import.meta.url)
try {
  const entry = statSync(fileURLToPath(candidateEntry))
  if (!entry.isFile()) throw new Error("candidate entry")
} catch {
  recordDesktopLoadDiagnostic("candidate_module_resolved", "module_not_found")
  throw new Error("Cycle candidate module resolution failed")
}
let candidate
try {
  candidate = await import(candidateEntry.href)
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  const status = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" ||
      code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    ? "dependency_resolution_failed"
    : "module_load_failed"
  recordDesktopLoadDiagnostic("candidate_module_resolved", status)
  throw new Error("Cycle candidate module resolution failed")
}
if (typeof candidate.default !== "function") {
  recordDesktopLoadDiagnostic("candidate_module_resolved", "export_mismatch")
  throw new Error("Cycle candidate module resolution failed")
}
const OpenCodeCycle = candidate.default
recordDesktopLoadDiagnostic("candidate_module_resolved", "passed")

const binaryPath = fileURLToPath(new URL("../opencode-cycle/bin/${nativeBinary}", import.meta.url))
const expectedPluginOptions = ${JSON.stringify(pluginOptions)}

export default async function OpenCodeCyclePlugin(input, options) {
  try {
    validateDesktopPluginInput(input)
    if (binaryPath !== expectedPluginOptions.binaryPath) throw new Error("binary mismatch")
    if (JSON.stringify(options) !== JSON.stringify(expectedPluginOptions)) throw new Error("options mismatch")
  } catch {
    recordDesktopLoadDiagnostic("plugin_entry_started", "failed")
    throw new Error("Cycle certification plugin entry binding is invalid")
  }
  recordDesktopLoadDiagnostic("plugin_entry_started", "passed")
  let hooks
  try {
    hooks = await OpenCodeCycle(input, options)
  } catch {
    recordDesktopLoadDiagnostic("plugin_entry_completed", "failed")
    throw new Error("Cycle candidate entry failed")
  }
  recordDesktopLoadDiagnostic("plugin_entry_completed", "passed")
  try {
    const daemon = statSync(join(expectedPluginOptions.certification.root, "desktop-daemon-runtime.json"))
    if (!daemon.isFile() || daemon.size < 1 || daemon.size > 64 * 1024) throw new Error("daemon marker")
  } catch {
    recordDesktopLoadDiagnostic("daemon_identity_published", "failed")
    throw new Error("Cycle candidate daemon identity was not published")
  }
  recordDesktopLoadDiagnostic("daemon_identity_published", "passed")
  if (typeof OpenCodeCycle.finalizeDesktopCertification !== "function") {
    throw new Error("Cycle candidate finalizer is unavailable")
  }
  await OpenCodeCycle.finalizeDesktopCertification(hooks, desktopLoadDiagnosticsFile)
  return hooks
}
`
  await Promise.all([
    writeFile(
      join(configDirectory, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ),
    writeFile(pluginLoader, loader, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  ])
  const configFile = join(configDirectory, "opencode.json")
  await writeFile(
    configFile,
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [[pathToFileURL(pluginLoader).href, pluginOptions]],
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  )
  const dependencyTree = await verifyDesktopDependencyTree(installRoot)
  return {
    configDirectory,
    configFile,
    dependencyTree,
    installedPlugin: installRoot,
    pluginLoader,
}
}

function desktopLoadDiagnosticWriterSource(
  diagnosticsFile: string,
  runtimeGuardDiagnosticsFile: string,
  binding: DesktopCertificationBinding,
): string {
  const runDigest = desktopCertificationBindingDigest(binding)
  return `
const desktopLoadDiagnosticRunDigest = ${JSON.stringify(runDigest)}
const desktopRuntimeGuardValue = process.env.${DESKTOP_RUNTIME_GUARD_ENV}
const desktopRuntimeGuardMode = desktopRuntimeGuardValue === desktopLoadDiagnosticRunDigest
if (desktopRuntimeGuardValue !== undefined && !desktopRuntimeGuardMode) {
  throw new Error("Desktop runtime guard binding is invalid")
}
const desktopLoadDiagnosticsFile = desktopRuntimeGuardMode
  ? ${JSON.stringify(runtimeGuardDiagnosticsFile)}
  : ${JSON.stringify(diagnosticsFile)}
const desktopLoadDiagnosticStages = ${JSON.stringify(DESKTOP_LOAD_DIAGNOSTIC_STAGES)}
const desktopLoadDiagnosticStatuses = ${JSON.stringify([
  "passed",
  ...DESKTOP_LOAD_DIAGNOSTIC_FAILURE_STATUSES,
])}

function readDesktopLoadTranscript() {
  const details = statSync(desktopLoadDiagnosticsFile)
  if (!details.isFile() || details.size > 64 * 1024) throw new Error("Desktop load transcript is invalid")
  const lines = readFileSync(desktopLoadDiagnosticsFile, "utf8").split("\\n").filter(Boolean)
  let failed = false
  return lines.map((line, sequence) => {
    let record
    try { record = JSON.parse(line) } catch { throw new Error("Desktop load transcript is invalid") }
    if (
      !record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== "runDigest,schemaVersion,sequence,stage,status,type" ||
      record.runDigest !== desktopLoadDiagnosticRunDigest ||
      record.schemaVersion !== 2 || record.sequence !== sequence ||
      record.stage !== desktopLoadDiagnosticStages[sequence] ||
      !desktopLoadDiagnosticStatuses.includes(record.status) ||
      record.type !== ${JSON.stringify(DESKTOP_LOAD_DIAGNOSTIC_TYPE)} || failed
    ) throw new Error("Desktop load transcript is invalid")
    if (record.status !== "passed") failed = true
    return record
  })
}

function recordDesktopLoadDiagnostic(stage, status) {
  const transcript = readDesktopLoadTranscript()
  if (transcript.some((record) => record.status !== "passed")) {
    throw new Error("Desktop load transcript is terminal")
  }
  const sequence = transcript.length
  if (desktopLoadDiagnosticStages[sequence] !== stage || !desktopLoadDiagnosticStatuses.includes(status)) {
    throw new Error("Desktop load transcript transition is invalid")
  }
  const line = JSON.stringify({
    runDigest: desktopLoadDiagnosticRunDigest,
    schemaVersion: 2,
    sequence,
    stage,
    status,
    type: ${JSON.stringify(DESKTOP_LOAD_DIAGNOSTIC_TYPE)},
  }) + "\\n"
  const handle = openSync(desktopLoadDiagnosticsFile, "a", 0o600)
  try {
    writeSync(handle, line, undefined, "utf8")
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}
`
}

function environmentBindingsForLoader(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    [
      "APPDATA",
      "CYCLE_CERTIFICATION_NONCE",
      "CYCLE_CERTIFICATION_ROOT",
      "HOME",
      "LOCALAPPDATA",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_TEST_HOME",
      "TEMP",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
    ].flatMap((name) => {
      const value = environment[name]
      return typeof value === "string" ? [[name, value]] : []
    }),
  )
}

function desktopEffectiveEnvironmentValidatorSource(
  scratch: string,
  configDirectory: string,
  configFile: string,
  expectedBindings: Readonly<Record<string, string>>,
): string {
  return `
const desktopCertificationScratch = ${JSON.stringify(resolve(scratch))}
const expectedDesktopBindings = ${JSON.stringify(expectedBindings)}

function isInsideDesktopScratch(value) {
  if (typeof value !== "string" || value.length === 0) return false
  const rel = relative(desktopCertificationScratch, resolve(value))
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep))
}

function validateDesktopEffectiveEnvironment() {
  for (const [name, expected] of Object.entries(expectedDesktopBindings)) {
    if (process.env[name] !== expected) throw new Error("binding")
  }
  if (process.env.OPENCODE_CONFIG_CONTENT !== undefined || process.env.OPENCODE_PURE !== undefined) {
    throw new Error("override")
  }
  const directories = [
    join(process.env.XDG_CONFIG_HOME, "opencode"),
    join(process.env.OPENCODE_TEST_HOME, ".opencode"),
    process.env.OPENCODE_CONFIG_DIR,
    dirname(process.env.OPENCODE_CONFIG),
    process.env.XDG_CACHE_HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
    process.cwd(),
  ]
  if (directories.some((directory) => !isInsideDesktopScratch(directory))) throw new Error("path")
  if (process.env.OPENCODE_CONFIG_DIR !== ${JSON.stringify(configDirectory)}) throw new Error("config dir")
  if (process.env.OPENCODE_CONFIG !== ${JSON.stringify(configFile)}) throw new Error("config file")
}

function validateDesktopPluginInput(input) {
  for (const value of [input?.directory, input?.worktree]) {
    if (value !== undefined && !isInsideDesktopScratch(value)) throw new Error("plugin input")
  }
}
`
}

async function appendDesktopLoadDiagnostic(
  diagnosticsFile: string,
  binding: DesktopCertificationBinding,
  stage: DesktopLoadDiagnosticStage,
  status: DesktopLoadDiagnosticStatus,
): Promise<void> {
  const transcript = await readDesktopLoadTranscript(diagnosticsFile, binding)
  if (transcript.some((record) => record.status !== "passed")) {
    throw new Error("Desktop load diagnostic transcript is terminal")
  }
  const sequence = transcript.length
  if (DESKTOP_LOAD_DIAGNOSTIC_STAGES[sequence] !== stage) {
    throw new Error("Desktop load diagnostic transcript transition is invalid")
  }
  const diagnostic: DesktopLoadDiagnostic = {
    runDigest: desktopCertificationBindingDigest(binding),
    schemaVersion: 2,
    sequence,
    stage,
    status,
    type: DESKTOP_LOAD_DIAGNOSTIC_TYPE,
  }
  const handle = await open(diagnosticsFile, "a", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(diagnostic)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function completeDesktopDaemonCleanupDiagnostic(
  diagnosticsFile: string,
  binding: DesktopCertificationBinding,
  status: DesktopLoadDiagnosticStatus,
): Promise<void> {
  const transcript = await readDesktopLoadTranscript(diagnosticsFile, binding)
  if (
    transcript.some((record) => record.status !== "passed") ||
    DESKTOP_LOAD_DIAGNOSTIC_STAGES[transcript.length] !== "daemon_cleanup_verified"
  ) {
    if (status === "passed") throw new Error("Desktop load transcript did not reach cleanup")
    return
  }
  await appendDesktopLoadDiagnostic(
    diagnosticsFile,
    binding,
    "daemon_cleanup_verified",
    status,
  )
}

async function copyDirectory(
  from: string,
  to: string,
  sourceRoot?: string,
  ancestors = new Set<string>(),
): Promise<void> {
  const root = sourceRoot ?? await realpath(resolve(from))
  const realSource = await realpath(resolve(from))
  if (!isDesktopHarnessPath(realSource, root)) {
    throw new Error("Desktop package material escapes its install source")
  }
  if (ancestors.has(realSource)) {
    throw new Error("Desktop package material contains a directory cycle")
  }
  const details = await stat(realSource)
  if (!details.isDirectory()) {
    throw new Error("Desktop package material root is not a directory")
  }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(realSource)
  await mkdir(to, { recursive: true })
  const entries = await readdir(realSource, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const source = join(realSource, entry.name)
    const destination = join(to, entry.name)
    const realEntry = await realpath(source)
    if (!isDesktopHarnessPath(realEntry, root)) {
      throw new Error("Desktop package material contains an external link")
    }
    const entryDetails = await stat(realEntry)
    if (entryDetails.isDirectory()) {
      await copyDirectory(realEntry, destination, root, nextAncestors)
    } else if (entryDetails.isFile()) {
      await copyFile(realEntry, destination)
    } else {
      throw new Error("Desktop package material contains a non-file entry")
    }
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

interface DesktopModuleRuntimeGuardExpected extends DesktopRuntimeLinkerExpected {
  readonly binding: DesktopCertificationBinding
  readonly bindingDigest: string
  readonly configDirectory: string
  readonly configFile: string
  readonly cwd: string
  readonly dependencyTree: DesktopDependencyTreeReceipt
  readonly environmentBindings: Readonly<Record<string, string>>
  readonly hostVersion: string
  readonly linker: string
  readonly linkerSha256: string
  readonly loader: string
  readonly loaderSha256: string
  readonly platform: CertifiedPlatform
  readonly scratch: string
}

export interface DesktopModuleRuntimeGuardPlan {
  readonly binding: DesktopCertificationBinding
  readonly command: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly expected: DesktopModuleRuntimeGuardExpected
  readonly runtimeGuardDiagnosticsFile: string
}

export interface DesktopModuleRuntimeExecution {
  readonly exitCode: number
  readonly outputExceeded: boolean
  readonly stderr: Buffer
  readonly stdout: Buffer
  readonly timedOut: boolean
}

interface DesktopModuleRuntimeInput {
  readonly binding: DesktopCertificationBinding
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly hostVersion: string
  readonly platform: CertifiedPlatform
  readonly prepared: PreparedDesktopCertificationLoad
  readonly runtimeCommand: readonly string[]
  readonly scratch: string
}

export async function prepareDesktopModuleRuntimeGuard(
  input: DesktopModuleRuntimeInput,
  verifiedContentTreeSha256?: string,
): Promise<DesktopModuleRuntimeGuardPlan> {
  if (
    input.hostVersion !== OPENCODE_DESKTOP_VERSION ||
    !CERTIFIED_PLATFORMS.includes(input.platform) ||
    input.runtimeCommand.length === 0 ||
    input.runtimeCommand.some((argument) => typeof argument !== "string" || argument.length === 0) ||
    !isDesktopHarnessPath(input.cwd, input.scratch)
  ) throw new Error("Official Desktop module runtime guard binding is invalid")
  const contentTreeSha256 = verifiedContentTreeSha256 ??
    await desktopContentTreeSha256(input.prepared.installedPlugin)
  const [manifestFile, configFile] = await Promise.all([
    readVerifiedRegularFile(join(input.prepared.installedPlugin, "package.json"), {
      maxBytes: 64 * 1024,
      root: input.prepared.installedPlugin,
    }),
    readVerifiedRegularFile(input.prepared.configFile, {
      maxBytes: 64 * 1024,
      root: input.prepared.configDirectory,
    }),
  ])
  const manifest = JSON.parse(manifestFile.content.toString("utf8")) as unknown
  if (!isRecord(manifest) || !isRecord(manifest.exports) || manifest.exports["."] !== "./dist/index.js") {
    throw new Error("Official Desktop module runtime guard candidate export is invalid")
  }
  const config = JSON.parse(configFile.content.toString("utf8")) as unknown
  if (!isRecord(config) || !Array.isArray(config.plugin) || config.plugin.length !== 1) {
    throw new Error("Official Desktop module runtime guard config tuple is invalid")
  }
  const tuple = config.plugin[0]
  if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[0] !== pathToFileURL(input.prepared.pluginLoader).href) {
    throw new Error("Official Desktop module runtime guard config specifier is invalid")
  }
  const options = tuple[1]
  if (
    !isRecord(options) ||
    Object.keys(options).sort().join(",") !== "binaryPath,certification,dataDirectory,hostVersion" ||
    JSON.stringify(options.certification) !== JSON.stringify(input.binding) ||
    options.hostVersion !== input.hostVersion ||
    typeof options.binaryPath !== "string" || !isAbsolute(options.binaryPath) ||
    typeof options.dataDirectory !== "string" || !isAbsolute(options.dataDirectory)
  ) throw new Error("Official Desktop module runtime guard config binding is invalid")

  const candidateEntry = resolve(input.prepared.installedPlugin, "dist", "index.js")
  if (!isDesktopHarnessPath(candidateEntry, input.prepared.installedPlugin)) {
    throw new Error("Official Desktop module runtime guard candidate entry is outside its package")
  }
  const dependencyTree = await verifyDesktopDependencyTree(input.prepared.installedPlugin)
  if (JSON.stringify(dependencyTree) !== JSON.stringify(input.prepared.dependencyTree)) {
    throw new Error("Official Desktop module runtime dependency tree changed")
  }
  const [candidate, loader] = await Promise.all([
    readVerifiedRegularFile(candidateEntry, {
      maxBytes: 4 * 1024 * 1024,
      root: dirname(candidateEntry),
    }),
    readVerifiedRegularFile(input.prepared.pluginLoader, {
      maxBytes: 256 * 1024,
      root: dirname(input.prepared.pluginLoader),
    }),
  ])
  const bindingDigest = desktopCertificationBindingDigest(input.binding)
  const resultFile = join(
    input.binding.root,
    DESKTOP_RUNTIME_GUARD_FILE_PREFIX + randomBytes(16).toString("hex") + ".json",
  )
  const certificationDirectory = join(input.prepared.configDirectory, "cycle-certification")
  const linker = join(certificationDirectory, "desktop-runtime-linker.mjs")
  const runtime = DESKTOP_ASSET_METADATA[input.platform].runtimeExecutable
  const linkerExpected: DesktopRuntimeLinkerExpected = {
    authoritative: true,
    candidateEntry,
    candidateEntrySha256: candidate.sha256,
    dependencyTreeSha256: dependencyTree.dependencyTreeSha256,
    electronVersion: OFFICIAL_DESKTOP_RUNTIME.electronVersion,
    installedPlugin: input.prepared.installedPlugin,
    nodeVersion: OFFICIAL_DESKTOP_RUNTIME.nodeVersion,
    resultFile,
    runtimeExecutableSha256: runtime.sha256,
    runtimeProductVersion: runtime.productVersion,
    verifiedContentTreeSha256: contentTreeSha256,
  }
  await writeFile(linker, await bundledDesktopRuntimeLinker(linkerExpected), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  })
  const linkerFile = await readVerifiedRegularFile(linker, {
    maxBytes: 512 * 1024,
    root: certificationDirectory,
  })
  const environmentBindings = environmentBindingsForLoader(input.environment)
  for (const [name, value] of Object.entries(environmentBindings)) {
    if (input.environment[name] !== value) {
      throw new Error("Official Desktop module runtime guard environment binding is invalid")
    }
  }
  for (const path of [
    input.cwd,
    input.environment.HOME,
    input.environment.TEMP,
    input.environment.TMP,
    input.environment.TMPDIR,
  ]) {
    if (typeof path !== "string" || !isDesktopHarnessPath(path, input.scratch)) {
      throw new Error("Official Desktop module runtime guard environment path is invalid")
    }
  }
  return {
    binding: input.binding,
    command: [
      ...input.runtimeCommand,
      "--no-warnings",
      "--experimental-vm-modules",
      linker,
    ],
    cwd: resolve(input.cwd),
    environment: Object.fromEntries(Object.entries({
      ...input.environment,
      ELECTRON_RUN_AS_NODE: "1",
    }).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])),
    expected: {
      ...linkerExpected,
      binding: input.binding,
      bindingDigest,
      configDirectory: input.prepared.configDirectory,
      configFile: input.prepared.configFile,
      cwd: resolve(input.cwd),
      dependencyTree,
      environmentBindings,
      hostVersion: input.hostVersion,
      linker,
      linkerSha256: linkerFile.sha256,
      loader: input.prepared.pluginLoader,
      loaderSha256: loader.sha256,
      platform: input.platform,
      scratch: resolve(input.scratch),
    },
    runtimeGuardDiagnosticsFile: input.prepared.runtimeGuardDiagnosticsFile,
  }
}

async function desktopContentTreeSha256(installedPlugin: string): Promise<string> {
  const verification = await openDesktopDependencyTreeVerification(installedPlugin)
  try {
    return verification.contentTreeSha256
  } finally {
    await verification.abort()
  }
}

export async function verifyDesktopModuleRuntime(
  input: DesktopModuleRuntimeInput,
): Promise<DesktopModuleRuntimeReceipt> {
  const dependencyVerification = await openDesktopDependencyTreeVerification(
    input.prepared.installedPlugin,
  )
  let graphInput: Awaited<ReturnType<typeof dependencyVerification.openLinkerInput>> | undefined
  try {
    if (
      JSON.stringify(dependencyVerification.receipt) !==
        JSON.stringify(input.prepared.dependencyTree)
    ) throw new Error("Official Desktop module runtime dependency handles changed")
    const plan = await prepareDesktopModuleRuntimeGuard(
      input,
      dependencyVerification.contentTreeSha256,
    )
    if (
      JSON.stringify(plan.expected.dependencyTree) !==
        JSON.stringify(dependencyVerification.receipt)
    ) throw new Error("Official Desktop module runtime dependency proof is inconsistent")
    graphInput = dependencyVerification.openLinkerInput()
    if (
      graphInput.contentTreeSha256 !== plan.expected.verifiedContentTreeSha256 ||
      graphInput.fileCount < plan.expected.dependencyTree.dependencyFileCount
    ) throw new Error("Official Desktop module runtime held input is inconsistent")
    const [executable, ...argumentsList] = plan.command
    if (executable === undefined) throw new Error("Official Desktop module runtime command is empty")
    const child = spawnChildProcess(executable, argumentsList, {
      cwd: plan.cwd,
      env: plan.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const inputTransfer = pipeline(graphInput.createReadStream(), child.stdin!).catch((error) => {
      child.kill()
      throw error
    })
    const childExited = new Promise<number>((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const exit = Promise.race([
      childExited,
      new Promise<number>((resolveExit) => {
        timeout = setTimeout(() => {
          timedOut = true
          child.kill()
          void childExited.then(resolveExit)
        }, 30_000)
      }),
    ])
    let exitCode: number
    let stdout: Buffer
    let stderr: Buffer
    let outputExceeded = false
    try {
      ;[exitCode, stdout, stderr] = await Promise.all([
        exit,
        readBoundedNodeRuntimeOutput(child.stdout!, () => {
          outputExceeded = true
          child.kill()
        }),
        readBoundedNodeRuntimeOutput(child.stderr!, () => {
          outputExceeded = true
          child.kill()
        }),
        inputTransfer,
      ]).then(([code, standardOutput, standardError]) =>
        [code, standardOutput, standardError] as const)
    } finally {
      clearTimeout(timeout)
    }
    const stableTree = await dependencyVerification.verifyAndClose()
    return validateDesktopModuleRuntimeGuard(plan, {
      exitCode,
      outputExceeded,
      stderr,
      stdout,
      timedOut,
    }, stableTree)
  } catch (error) {
    await dependencyVerification.abort()
    throw error
  } finally {
    await graphInput?.close().catch(() => undefined)
  }
}

export async function validateDesktopModuleRuntimeGuard(
  plan: DesktopModuleRuntimeGuardPlan,
  execution: DesktopModuleRuntimeExecution,
  stableDependencyTree?: DesktopDependencyTreeReceipt,
): Promise<DesktopModuleRuntimeReceipt> {
  const outputDigest = createHash("sha256")
    .update(execution.stdout)
    .update("\0")
    .update(execution.stderr)
    .digest("hex")
  if (
    execution.timedOut || execution.outputExceeded || execution.exitCode !== 0 ||
    execution.stdout.length !== 0 || execution.stderr.length !== 0
  ) {
    const errorClass = execution.timedOut
      ? "timeout"
      : execution.outputExceeded ? "output_limit" : "runtime_exit"
    throw new Error(
      "Official Desktop module runtime guard failed: class=" + errorClass +
      ", code=" + execution.exitCode + ", output_sha256=" + outputDigest,
    )
  }
  const dependencyTree = stableDependencyTree ??
    await verifyDesktopDependencyTree(plan.expected.installedPlugin)
  const [result, candidate, loader, linker] = await Promise.all([
    readVerifiedRegularFile(plan.expected.resultFile, {
      maxBytes: 64 * 1024,
      root: plan.binding.root,
    }),
    readVerifiedRegularFile(plan.expected.candidateEntry, {
      maxBytes: 4 * 1024 * 1024,
      root: dirname(plan.expected.candidateEntry),
    }),
    readVerifiedRegularFile(plan.expected.loader, {
      maxBytes: 256 * 1024,
      root: dirname(plan.expected.loader),
    }),
    readVerifiedRegularFile(plan.expected.linker, {
      maxBytes: 512 * 1024,
      root: dirname(plan.expected.linker),
    }),
  ])
  if (
    candidate.sha256 !== plan.expected.candidateEntrySha256 ||
    loader.sha256 !== plan.expected.loaderSha256 ||
    linker.sha256 !== plan.expected.linkerSha256 ||
    JSON.stringify(dependencyTree) !== JSON.stringify(plan.expected.dependencyTree)
  ) throw new Error("Official Desktop module runtime material changed during proof")
  const linkReceipt = JSON.parse(result.content.toString("utf8")) as unknown
  assertDesktopModuleLinkReceipt(linkReceipt, plan.expected)
  await appendDesktopRuntimeGuardDiagnostics(plan)
  const guardDiagnostics = await readDesktopLoadTranscript(
    plan.runtimeGuardDiagnosticsFile,
    plan.binding,
  )
  if (
    guardDiagnostics.length !== 6 ||
    guardDiagnostics.some((record) => record.status !== "passed") ||
    guardDiagnostics.at(-1)?.stage !== "candidate_module_resolved"
  ) throw new Error("Official Desktop module runtime guard diagnostics are incomplete")
  const tree = plan.expected.dependencyTree
  return {
    bindingDigest: plan.expected.bindingDigest,
    candidateDefaultExportLinked: true,
    candidateEntrySha256: plan.expected.candidateEntrySha256,
    candidateEvaluated: false,
    dependencyFileCount: tree.dependencyFileCount,
    dependencyPackageCount: tree.dependencyPackageCount,
    dependencyTotalBytes: tree.dependencyTotalBytes,
    dependencyTreeSha256: tree.dependencyTreeSha256,
    unsafeDynamicImportsRejected: true,
    unsafeModuleLoadingRejected: true,
    electronVersion: linkReceipt.electronVersion,
    graphFileCount: linkReceipt.graphFileCount,
    graphSha256: linkReceipt.graphSha256,
    linkedEsmModuleCount: linkReceipt.linkedEsmModuleCount,
    linkerSha256: plan.expected.linkerSha256,
    loaderSha256: plan.expected.loaderSha256,
    moduleLinked: true,
    nativePackageSha256: plan.expected.binding.nativePackageSha256,
    nodeVersion: linkReceipt.nodeVersion,
    pluginPackageSha256: plan.expected.binding.pluginPackageSha256,
    productVersion: plan.expected.hostVersion,
    revision: plan.expected.binding.revision,
    runtimeExecutableSha256: linkReceipt.runtimeExecutableSha256,
    runtimeProductVersion: linkReceipt.runtimeProductVersion,
    schemaVersion: 4,
    suppressedOptionalRootCount: linkReceipt.suppressedOptionalRootCount,
    type: DESKTOP_RUNTIME_GUARD_TYPE,
    verifiedAssetFileCount: linkReceipt.verifiedAssetFileCount,
    verifiedCommonJsModuleCount: linkReceipt.verifiedCommonJsModuleCount,
    verifiedContentTreeSha256: linkReceipt.verifiedContentTreeSha256,
    verifiedJsonModuleCount: linkReceipt.verifiedJsonModuleCount,
  }
}

function assertDesktopModuleLinkReceipt(
  value: unknown,
  expected: DesktopModuleRuntimeGuardExpected,
): asserts value is {
  readonly electronVersion: string
  readonly graphFileCount: number
  readonly graphSha256: string
  readonly linkedEsmModuleCount: number
  readonly nodeVersion: string
  readonly runtimeExecutableSha256: string
  readonly runtimeProductVersion: string
  readonly suppressedOptionalRootCount: number
  readonly verifiedAssetFileCount: number
  readonly verifiedCommonJsModuleCount: number
  readonly verifiedContentTreeSha256: string
  readonly verifiedJsonModuleCount: number
} {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "candidateDefaultExportLinked,candidateEntrySha256,candidateEvaluated,dependencyTreeSha256,electronVersion,graphFileCount,graphSha256,linkedEsmModuleCount,nodeVersion,runtimeExecutableSha256,runtimeProductVersion,schemaVersion,suppressedOptionalRootCount,type,unsafeDynamicImportsRejected,unsafeModuleLoadingRejected,verifiedAssetFileCount,verifiedCommonJsModuleCount,verifiedContentTreeSha256,verifiedJsonModuleCount" ||
    value.candidateDefaultExportLinked !== true ||
    value.candidateEntrySha256 !== expected.candidateEntrySha256 ||
    value.candidateEvaluated !== false ||
    value.dependencyTreeSha256 !== expected.dependencyTreeSha256 ||
    value.unsafeDynamicImportsRejected !== true ||
    value.electronVersion !== expected.electronVersion ||
    typeof value.graphFileCount !== "number" ||
    !Number.isSafeInteger(value.graphFileCount) ||
    value.graphFileCount < 1 ||
    typeof value.graphSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.graphSha256) ||
    typeof value.linkedEsmModuleCount !== "number" ||
    !Number.isSafeInteger(value.linkedEsmModuleCount) ||
    value.linkedEsmModuleCount < 1 ||
    typeof value.verifiedCommonJsModuleCount !== "number" ||
    !Number.isSafeInteger(value.verifiedCommonJsModuleCount) ||
    value.verifiedCommonJsModuleCount < 0 ||
    typeof value.verifiedJsonModuleCount !== "number" ||
    !Number.isSafeInteger(value.verifiedJsonModuleCount) ||
    value.verifiedJsonModuleCount < 0 ||
    typeof value.verifiedAssetFileCount !== "number" ||
    !Number.isSafeInteger(value.verifiedAssetFileCount) ||
    value.verifiedAssetFileCount < 0 ||
    value.linkedEsmModuleCount + value.verifiedCommonJsModuleCount +
      value.verifiedJsonModuleCount + value.verifiedAssetFileCount !== value.graphFileCount ||
    typeof value.suppressedOptionalRootCount !== "number" ||
    !Number.isSafeInteger(value.suppressedOptionalRootCount) ||
    value.suppressedOptionalRootCount < 0 ||
    value.verifiedContentTreeSha256 !== expected.verifiedContentTreeSha256 ||
    value.unsafeModuleLoadingRejected !== true ||
    value.nodeVersion !== expected.nodeVersion ||
    value.runtimeExecutableSha256 !== expected.runtimeExecutableSha256 ||
    value.runtimeProductVersion !== expected.runtimeProductVersion ||
    value.schemaVersion !== 2 ||
    value.type !== "opencode-cycle-desktop-module-link"
  ) throw new Error("Official Desktop module link receipt is invalid")
}

async function appendDesktopRuntimeGuardDiagnostics(
  plan: DesktopModuleRuntimeGuardPlan,
): Promise<void> {
  for (const stage of [
    "config_path_discovered",
    "plugin_specifier_resolved",
    "effective_env_validated",
    "candidate_module_resolved",
  ] as const) {
    const transcript = await readDesktopLoadTranscript(
      plan.runtimeGuardDiagnosticsFile,
      plan.binding,
    )
    if (DESKTOP_LOAD_DIAGNOSTIC_STAGES[transcript.length] !== stage) {
      throw new Error("Official Desktop module runtime diagnostic transition is invalid")
    }
    const handle = await open(plan.runtimeGuardDiagnosticsFile, "a")
    try {
      await handle.writeFile(JSON.stringify({
        runDigest: plan.expected.bindingDigest,
        schemaVersion: 2,
        sequence: transcript.length,
        stage,
        status: "passed",
        type: DESKTOP_LOAD_DIAGNOSTIC_TYPE,
      }) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

async function readBoundedRuntimeOutput(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (bytes + value.byteLength > 64 * 1024) {
      onLimit()
      break
    }
    const chunk = Buffer.from(value)
    chunks.push(chunk)
    bytes += chunk.byteLength
  }
  return Buffer.concat(chunks)
}

async function readBoundedNodeRuntimeOutput(
  stream: Readable,
  onLimit: () => void,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    if (bytes + chunk.byteLength > 64 * 1024) {
      onLimit()
      break
    }
    chunks.push(chunk)
    bytes += chunk.byteLength
  }
  return Buffer.concat(chunks)
}

async function prepareDesktop(
  platform: CertifiedPlatform,
  asset: string,
  scratch: string,
  environment: NodeJS.ProcessEnv,
): Promise<{
  authenticity: DesktopAuthenticity
  launch: string[]
  moduleRuntimeCommand: string[]
}> {
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
      moduleRuntimeCommand: [extraction.executable],
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
      moduleRuntimeCommand: [appRun],
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

export async function desktopLoadDiagnosticSummary(
  root: string,
  binding: DesktopCertificationBinding,
): Promise<string> {
  const diagnosticsFile = join(root, DESKTOP_LOAD_DIAGNOSTIC_FILE)
  const transcript = await readDesktopLoadTranscript(diagnosticsFile, binding)
  const latest = new Map(transcript.map((record) => [record.stage, record.status]))
  return DESKTOP_LOAD_DIAGNOSTIC_STAGES
    .map((stage) => `${stage}=${latest.get(stage) ?? "missing"}`)
    .join(", ")
}

async function readDesktopLoadTranscript(
  diagnosticsFile: string,
  binding: DesktopCertificationBinding,
): Promise<DesktopLoadDiagnostic[]> {
  const present = await lstat(diagnosticsFile).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  if (!present) return []
  const root = binding.root
  const file = await readVerifiedRegularFile(diagnosticsFile, { maxBytes: 64 * 1024, root })
  const lines = file.content.toString("utf8").split("\n").filter((line) => line.length > 0)
  const transcript: DesktopLoadDiagnostic[] = []
  let terminal = false
  for (let sequence = 0; sequence < lines.length; sequence += 1) {
    let value: unknown
    try {
      value = JSON.parse(lines[sequence] as string) as unknown
    } catch {
      throw new Error("Desktop load diagnostic transcript is malformed")
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Desktop load diagnostic transcript is malformed")
    }
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).sort().join(",") !== "runDigest,schemaVersion,sequence,stage,status,type" ||
      record.runDigest !== desktopCertificationBindingDigest(binding) ||
      record.schemaVersion !== 2 ||
      record.sequence !== sequence ||
      record.stage !== DESKTOP_LOAD_DIAGNOSTIC_STAGES[sequence] ||
      (record.status !== "passed" && !DESKTOP_LOAD_DIAGNOSTIC_FAILURE_STATUSES.includes(
        record.status as DesktopLoadDiagnosticFailureStatus,
      )) ||
      record.type !== DESKTOP_LOAD_DIAGNOSTIC_TYPE ||
      terminal
    ) {
      throw new Error("Desktop load diagnostic transcript is invalid")
    }
    const diagnostic = record as unknown as DesktopLoadDiagnostic
    transcript.push(diagnostic)
    if (diagnostic.status !== "passed") terminal = true
  }
  return transcript
}

export async function waitForDesktopActivation(
  root: string,
  binding: DesktopCertificationBinding,
  timeout: number,
  dependencies: {
    readonly now?: () => number
    readonly sleep?: (milliseconds: number) => Promise<void>
  } = {},
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
        marker.nativePackageSha256 !== binding.nativePackageSha256 ||
        marker.runDigest !== desktopCertificationBindingDigest(binding) ||
        marker.daemon.startToken !== desktopCertificationProcessToken(binding) ||
        marker.daemon.startedAtUnixMillis < binding.startedAtUnixMillis ||
        marker.daemon.startedAtUnixMillis > marker.createdAtUnixMillis
      ) {
        throw new Error("Desktop activation marker does not match the run nonce, revision and packages")
      }
      if (
        marker.createdAtUnixMillis < binding.startedAtUnixMillis ||
        marker.createdAtUnixMillis > now() + 5_000
      ) {
        throw new Error("Desktop activation marker time is outside the isolated certification run")
      }
      await appendDesktopLoadDiagnostic(
        join(root, DESKTOP_LOAD_DIAGNOSTIC_FILE),
        binding,
        "activation_marker_verified",
        "passed",
      )
      return { digest: file.sha256, marker }
    }
    await sleep(1_000)
  }
  await recordMissingDesktopLoadBoundary(root, binding).catch(() => undefined)
  const diagnostics = await desktopLoadDiagnosticSummary(root, binding).catch(() => "invalid")
  throw new Error(
    `OpenCode Desktop did not activate the installed Cycle plugin; Desktop load diagnostics: ${diagnostics}`,
  )
}

async function recordMissingDesktopLoadBoundary(
  root: string,
  binding: DesktopCertificationBinding,
): Promise<void> {
  const diagnosticsFile = join(root, DESKTOP_LOAD_DIAGNOSTIC_FILE)
  const transcript = await readDesktopLoadTranscript(diagnosticsFile, binding)
  if (
    transcript.every((record) => record.status === "passed") &&
    DESKTOP_LOAD_DIAGNOSTIC_STAGES[transcript.length] === "config_path_discovered"
  ) {
    await appendDesktopLoadDiagnostic(
      diagnosticsFile,
      binding,
      "config_path_discovered",
      "shell_or_config_root_failed",
    )
  }
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
  const candidates = [
    scratchRoot,
    ...(scratchRoot === undefined ? [tmpdir(), "/tmp", "/var/tmp"] : []),
    environment.HOME,
    environment.TEMP,
    environment.TMP,
    environment.TMPDIR,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    environment.LOCALAPPDATA,
    environment.APPDATA,
  ].filter((path): path is string => typeof path === "string" && path.length > 0)
  return [...new Set(candidates)].filter(
    (path) => scratchRoot === undefined || isDesktopHarnessPath(path, scratchRoot),
  )
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

export function isCertificationOnboardingProfile(path: string, scratch: string): boolean {
  return isDesktopHarnessPath(path, scratch) && basename(path).startsWith("opencode-onboarding-")
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
      if (
        scratch !== undefined &&
        isDesktopHarnessPath(profile, scratch) &&
        !isCertificationOnboardingProfile(profile, scratch)
      ) continue
      return profile
    }
    const observed: string[] = []
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const candidate = join(root, entry.name)
        if (entry.isDirectory() && !existing.has(candidate)) {
          if (
            scratch !== undefined &&
            isDesktopHarnessPath(candidate, scratch) &&
            !isCertificationOnboardingProfile(candidate, scratch)
          ) continue
          observed.push(candidate)
          if (isDesktopTestProfileName(entry.name)) return candidate
          const discovered = await discoverProfileRoots(candidate, 3)
          const fallback = discovered.find(
            (path) =>
              scratch === undefined ||
              !isDesktopHarnessPath(path, scratch) ||
              isCertificationOnboardingProfile(path, scratch),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
