import { createHash, randomBytes, type Hash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { DesktopCertificationBinding } from "../../packages/opencode-cycle/src/certification.js"
import { packageNative, type NativeTarget } from "../packaging/native-package.js"
import { PRODUCT_IDENTITY } from "../product-identity.js"
import {
  authoritativePluginPackageMode,
  readAuthoritativePluginPackage,
} from "./authoritative-plugin-package.js"
import { cleanupCertifiedDaemon } from "./certified-daemon.js"
import {
  certificationEnvironment,
  completeDesktopDaemonCleanupDiagnostic,
  desktopLoadDiagnosticStages,
  desktopLoadDiagnosticSummary,
  prepareDesktopCertificationLoad,
  verifyDesktopModuleRuntime,
  waitForDesktopActivation,
  type DesktopModuleRuntimeEvidenceMaterial,
} from "./desktop-certification.js"
import { serializeDesktopDependencyTreeManifest } from "./desktop-dependency-tree.js"
import {
  digestOfficialEvidenceError,
  openOfficialRuntimeEvidenceDirectory,
  serializeOfficialRuntimeProvenance,
  type OfficialGateOutputSummary,
  type OfficialRuntimeEvidenceSession,
} from "./official-runtime-evidence.js"
import { OPENCODE_11821_HOST_PROOF_PROVENANCE, type OpenCodeHostProofReceipt } from "./opencode-1.18.21-host-proof.js"
import { systemTarExecutable } from "../system-tar.js"
import {
  packedPluginDaemonEndpointEvidence,
  packedPluginDataDirectory,
  packedPluginScratchPrefix,
} from "./packed-plugin-paths.js"

const GATE_OUTPUT_LIMIT = 16 * 1024 * 1024

class PackageGateFailure extends Error {
  readonly errorClass: string

  constructor(errorClass: string) {
    super("Packed plugin gate failed")
    this.name = "PackageGateFailure"
    this.errorClass = errorClass
  }
}

class BoundedGateOutput {
  private readonly stderr = outputChannel()
  private readonly stdout = outputChannel()

  capture(channel: "stderr" | "stdout", value: Uint8Array): boolean {
    const state = this[channel]
    const remaining = GATE_OUTPUT_LIMIT - state.bytes
    const captured = value.subarray(0, Math.max(remaining, 0))
    state.hash.update(captured)
    state.bytes += captured.byteLength
    if (captured.byteLength !== value.byteLength) state.truncated = true
    return !state.truncated
  }

  summary(): OfficialGateOutputSummary {
    return {
      stderrBytes: this.stderr.bytes,
      stderrSha256: this.stderr.hash.copy().digest("hex"),
      stderrTruncated: this.stderr.truncated,
      stdoutBytes: this.stdout.bytes,
      stdoutSha256: this.stdout.hash.copy().digest("hex"),
      stdoutTruncated: this.stdout.truncated,
    }
  }
}

function outputChannel(): { bytes: number; hash: Hash; truncated: boolean } {
  return { bytes: 0, hash: createHash("sha256"), truncated: false }
}

// A directory URL resolves with a trailing separator, which is not a canonical
// path: evidence redaction rejects any sensitive path that does not equal its
// own resolution, and rejected the repository root before the gate could start.
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const packageRoot = join(root, "packages", PRODUCT_IDENTITY.mainPackage)
const gateOutput = new BoundedGateOutput()
let scratch: string | undefined
let launcherTemporary: string | undefined
let launcher: string | undefined
let launcherStop: string | undefined
let proof: ReturnType<typeof Bun.spawn> | undefined
let officialEvidence: OfficialRuntimeEvidenceSession | undefined
let runtimeEvidence: DesktopModuleRuntimeEvidenceMaterial | undefined
let dependencyTreeEvidence: Buffer | undefined
let revision: string | undefined
let currentStage = "gate-open"
let runtimeFailureClass: string | undefined
let reportedHostDiagnosticCount = 0

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 5 * 60_000)
  const results = await Promise.allSettled([
    readGateOutput(child.stdout as ReadableStream<Uint8Array>, "stdout", child),
    readGateOutput(child.stderr as ReadableStream<Uint8Array>, "stderr", child),
    child.exited,
  ])
  clearTimeout(timeout)
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure !== undefined) {
    child.kill()
    await child.exited
    throw failure.reason
  }
  const [stdoutResult, , exitResult] = results as [
    PromiseFulfilledResult<Buffer>,
    PromiseFulfilledResult<Buffer>,
    PromiseFulfilledResult<number>,
  ]
  if (timedOut) throw new PackageGateFailure("package_timeout")
  if (exitResult.value !== 0) throw new PackageGateFailure("package_command")
  return stdoutResult.value.toString("utf8")
}

try {
  const officialEvidenceDirectory = process.env.CYCLE_OFFICIAL_ELECTRON_EVIDENCE_DIR
  if (officialEvidenceDirectory !== undefined) {
    officialEvidence = await openOfficialRuntimeEvidenceDirectory(officialEvidenceDirectory)
    officialEvidence.registerSensitiveValues({ absolutePaths: [root] })
    await recordStage("gate-started", { official: true })
  }
  const authoritativeArchive = process.env.CYCLE_OFFICIAL_PLUGIN_ARCHIVE
  const authoritativeProvenance = process.env.CYCLE_OFFICIAL_PLUGIN_PROVENANCE
  const pluginPackageMode = authoritativePluginPackageMode({
    ...(authoritativeArchive === undefined ? {} : { archive: authoritativeArchive }),
    official: officialEvidence !== undefined,
    ...(authoritativeProvenance === undefined ? {} : { provenance: authoritativeProvenance }),
  })
  if (pluginPackageMode === "authoritative-prebuilt") {
    officialEvidence?.registerSensitiveValues({
      absolutePaths: [resolve(authoritativeArchive!), resolve(authoritativeProvenance!)],
    })
  }
  revision = (await run(["git", "rev-parse", "HEAD"], root)).trim()
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new PackageGateFailure("source_binding")
  await recordStage("source-bound", { revision })
  scratch = await mkdtemp(join(tmpdir(), packedPluginScratchPrefix(process.platform)))
  launcherTemporary = await mkdtemp(join(tmpdir(), "opencode-cycle-host-launcher-"))
  launcher = join(launcherTemporary, "launcher.ts")
  launcherStop = join(launcherTemporary, "stop")
  officialEvidence?.registerSensitiveValues({
    absolutePaths: [scratch, launcherTemporary, launcher, launcherStop],
  })
  const extracted = join(scratch, "extracted")
  const nativeArtifacts = join(scratch, "native")
  const secondPack = join(scratch, "second-pack")
  await mkdir(extracted, { recursive: true })
  await mkdir(secondPack, { recursive: true })
  await recordStage("scratch-created")
  await writeFile(launcher, `
import { access } from "node:fs/promises"
const [cwd, stop, ...command] = Bun.argv.slice(2)
if (!cwd || !stop || command.length === 0) throw new Error("launcher arguments are missing")
const child = Bun.spawn(command, { cwd, env: process.env, stderr: "ignore", stdout: "ignore" })
while (child.exitCode === null) {
  if (await access(stop).then(() => true, () => false)) {
    child.kill()
    break
  }
  await Bun.sleep(25)
}
process.exit(await child.exited)
`)
  await recordStage("native-build-started")
  await run(["cargo", "build", "-p", "workflowd", "--release"], root)
  await recordStage("native-build-completed")
  const nativeTarget = `${process.platform}-${process.arch}` as NativeTarget
  const executable = process.platform === "win32" ? "workflowd.exe" : "workflowd"
  const native = await packageNative(
    root,
    nativeTarget,
    join(root, "target", "release", executable),
    nativeArtifacts,
  )
  await recordStage("native-package-completed", { nativeTarget })
  let archive: string
  if (pluginPackageMode === "authoritative-prebuilt") {
    const input = await readAuthoritativePluginPackage({
      archive: authoritativeArchive!,
      provenance: authoritativeProvenance!,
      revision,
      root,
    })
    archive = join(scratch, input.name)
    await writeFile(archive, input.content, { flag: "wx", mode: 0o600 })
    await recordStage("plugin-prebuilt-validated", { pluginPackageSha256: input.sha256 })
  } else {
    await run(["bun", "pm", "pack", "--destination", scratch], packageRoot)
    const archiveName = (await readdir(scratch)).find((name) => name.endsWith(".tgz"))
    if (archiveName === undefined) throw new Error("Plugin pack did not produce an archive")
    archive = join(scratch, archiveName)
    await run(["bun", "pm", "pack", "--destination", secondPack], packageRoot)
    const secondArchiveName = (await readdir(secondPack)).find((name) => name.endsWith(".tgz"))
    if (secondArchiveName === undefined) throw new Error("Second plugin pack did not produce an archive")
    if ((await digest(archive)) !== (await digest(join(secondPack, secondArchiveName)))) {
      throw new Error("Plugin package is not reproducible from identical inputs")
    }
    await recordStage("plugin-pack-completed")
  }
  const listing = (await run([systemTarExecutable(), "-tf", archive], root)).split(/\r?\n/u).filter(Boolean)
  for (const required of ["package/package.json", "package/dist/index.js", "package/LICENSE", "package/NOTICE"]) {
    if (!listing.includes(required)) throw new Error(`Packed plugin is missing ${required}`)
  }
  const unexpected = listing.find(
    (path) =>
      !["package/package.json", "package/LICENSE", "package/NOTICE"].includes(path) &&
      !/^package\/dist\/(?:[^/]+\/)*[^/]+\.(?:cjs|js|mjs)$/u.test(path),
  )
  if (unexpected !== undefined) {
    throw new Error(`Packed plugin contains non-production file ${unexpected}`)
  }

  await run([systemTarExecutable(), "-xf", archive, "-C", extracted], root)
  const installedPackage = join(extracted, "package")
  await run(
    ["bun", "install", "--backend=copyfile", "--ignore-scripts", "--linker=hoisted", "--production", "--no-save", native.archive],
    installedPackage,
  )
  await recordStage("dependency-tree-installed")
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64"
  const certificationRoot = join(scratch, "certification")
  await recordStage("host-daemon-endpoint-preparing")
  const dataDirectory = packedPluginDataDirectory(scratch, process.platform)
  const endpointEvidence = packedPluginDaemonEndpointEvidence(dataDirectory, process.platform)
  await recordStage("host-daemon-endpoint-prepared", endpointEvidence)
  const project = join(scratch, "project")
  await Promise.all([mkdir(certificationRoot), mkdir(project)])
  const binding: DesktopCertificationBinding = {
    nativePackageSha256: native.checksum,
    nonce: randomBytes(32).toString("hex"),
    pluginPackageSha256: await digest(archive),
    revision,
    root: certificationRoot,
    startedAtUnixMillis: Date.now(),
  }
  const environment = certificationEnvironment(scratch, platform, process.env, binding)
  officialEvidence?.registerSensitiveValues({
    absolutePaths: [
      archive,
      certificationRoot,
      dataDirectory,
      environmentPath(environment, "OPENCODE_CONFIG"),
      environmentPath(environment, "OPENCODE_CONFIG_DIR"),
      installedPackage,
      join(root, "target", "release", executable),
      native.archive,
    ],
    nonce: binding.nonce,
  })
  await Promise.all([
    mkdir(environment.HOME as string, { recursive: true }),
    mkdir(environment.TMPDIR as string, { recursive: true }),
    mkdir(environment.XDG_CACHE_HOME as string, { recursive: true }),
    mkdir(environment.XDG_CONFIG_HOME as string, { recursive: true }),
    mkdir(environment.XDG_DATA_HOME as string, { recursive: true }),
    mkdir(environment.XDG_STATE_HOME as string, { recursive: true }),
  ])
  const prepared = await prepareDesktopCertificationLoad({
    certification: binding,
    dataDirectory,
    environment,
    hostVersion: "1.18.21",
    nativeExecutable: join(root, "target", "release", executable),
    packedPlugin: installedPackage,
    platform,
    scratch,
  })
  await recordStage("runtime-input-prepared")
  const officialRuntime = process.env.CYCLE_OFFICIAL_ELECTRON_RUNTIME
  if (officialRuntime === undefined) {
    throw new Error("Packed plugin gate requires an official Electron runtime")
  }
  const runtime = resolve(officialRuntime)
  if (!isAbsolute(officialRuntime) || runtime !== officialRuntime) {
    throw new Error("Official Electron runtime path must be canonical and absolute")
  }
  officialEvidence?.registerSensitiveValues({ absolutePaths: [runtime] })
  await access(runtime)
  await recordStage("runtime-guard-started")
  await verifyDesktopModuleRuntime({
    binding,
    ...(officialEvidence === undefined
      ? {}
      : {
          captureEvidence: async (material: DesktopModuleRuntimeEvidenceMaterial) => {
            if (runtimeEvidence !== undefined) {
              throw new Error("Official Electron runtime evidence was captured more than once")
            }
            runtimeEvidence = material
          },
        }),
    cwd: project,
    environment,
    hostVersion: "1.18.21",
    platform,
    prepared,
    ...(officialEvidence === undefined
      ? {}
      : {
          reportEvidenceStage: async (
            stage: string,
            details: Readonly<Record<string, boolean | number | string | null>>,
          ) => {
            if (stage === "runtime-completed" && typeof details.errorClass === "string") {
              runtimeFailureClass = details.errorClass
            }
            await recordStage(stage, details)
          },
        }),
    runtimeCommand: [runtime],
    scratch,
  })
  await recordStage("runtime-guard-passed")
  if (officialEvidence !== undefined) {
    if (runtimeEvidence === undefined) {
      throw new Error("Official Electron runtime evidence material was not captured")
    }
    await recordStage("evidence-material-preparing")
    dependencyTreeEvidence = serializeDesktopDependencyTreeManifest({
      contentTreeSha256: runtimeEvidence.contentTreeSha256,
      dependencyTree: runtimeEvidence.dependencyTree,
      files: runtimeEvidence.contentManifest,
    })
    await recordStage("evidence-material-prepared", {
      dependencyManifestBytes: dependencyTreeEvidence.byteLength,
      dependencyManifestSha256: digestBytes(dependencyTreeEvidence),
    })
  }
  await recordStage("host-proof-started")
  await recordHostDiagnosticStages(certificationRoot, binding)
  const proofRequest = join(scratch, "host-proof-request.json")
  const proofResult = join(scratch, "host-proof-result.json")
  const proofRelease = join(certificationRoot, "host-proof-release")
  await writeFile(proofRequest, `${JSON.stringify({
    binding,
    candidatePackageRoot: prepared.installedPlugin,
    configFile: prepared.configFile,
    directory: project,
    releaseFile: proofRelease,
    resultFile: proofResult,
    worktree: project,
  })}\n`)
  proof = Bun.spawn(
    [
      process.execPath,
      launcher,
      scratch,
      launcherStop,
      process.execPath,
      join(root, "scripts", "ci", "opencode-1.18.21-host-proof.ts"),
      "--request",
      proofRequest,
    ],
    { cwd: root, env: environment, stderr: "ignore", stdout: "ignore" },
  )
  let proofReady = false
  let proofExitedEarly = false
  for (let attempt = 0; attempt < 300; attempt += 1) {
    proofReady = await access(proofResult).then(() => true, () => false)
    if (attempt % 50 === 0) {
      await recordHostDiagnosticStages(certificationRoot, binding).catch(() => undefined)
    }
    if (proofReady) break
    if (proof.exitCode !== null) {
      proofExitedEarly = true
      break
    }
    await Bun.sleep(50)
  }
  if (!proofReady) {
    if (proof.exitCode === null) await writeFile(launcherStop, "stop\n", { flag: "wx" })
    await proof.exited
    await recordHostDiagnosticStages(certificationRoot, binding)
    await recordStage("host-proof-failed", {
      errorCode: proofExitedEarly ? "HOST_EXIT_BEFORE_RESULT" : "HOST_RESULT_TIMEOUT",
      exitCode: proof.exitCode,
      resultPresent: false,
      timedOut: !proofExitedEarly,
    })
    throw new Error("Packed plugin failed the OpenCode 1.18.21 host proof")
  }
  await recordHostDiagnosticStages(certificationRoot, binding)
  const hostReceipt = JSON.parse(await readFile(proofResult, "utf8")) as OpenCodeHostProofReceipt
  if (
    hostReceipt.provenanceCommit !== OPENCODE_11821_HOST_PROOF_PROVENANCE.commit ||
    hostReceipt.mergedOrigins !== 3 ||
    hostReceipt.deduplicatedOrigins !== 1 ||
    hostReceipt.loadedPlugins !== 1 ||
    !hostReceipt.tupleOptions
  ) throw new Error("Packed plugin host proof receipt is invalid")
  const activation = await waitForDesktopActivation(certificationRoot, binding, 5_000)
  await recordStage("host-activation-finalized", { markerPresent: true })
  if (proof.exitCode !== null) throw new Error("Packed plugin host exited before daemon shutdown")
  const cleanup = await cleanupCertifiedDaemon({
    binding,
    dataDirectory,
    expectedBinaryPath: join(prepared.installedPlugin, "bin", executable),
    expectedDaemon: activation.marker.daemon,
    platform,
  })
  if (
    !cleanup.markerPublished ||
    !cleanup.exitMarkerPublished ||
    !cleanup.processAbsent ||
    !cleanup.shutdownAuthenticated ||
    !cleanup.terminated
  ) throw new Error("Packed plugin did not complete authenticated daemon shutdown")
  await recordStage("host-authenticated-shutdown", {
    exitMarkerPublished: cleanup.exitMarkerPublished,
    markerPublished: cleanup.markerPublished,
    shutdownAuthenticated: cleanup.shutdownAuthenticated,
    terminated: cleanup.terminated,
  })
  await recordStage("host-daemon-absent", { processAbsent: cleanup.processAbsent })
  if (proof.exitCode !== null) throw new Error("Packed plugin host exited during daemon shutdown")
  await writeFile(proofRelease, "release\n", { flag: "wx" })
  if ((await proof.exited) !== 0) throw new Error("OpenCode 1.18.21 host proof exited after cleanup")
  await recordStage("host-proof-completed")
  await completeDesktopDaemonCleanupDiagnostic(prepared.diagnosticsFile, binding, "passed")
  const diagnostics = await desktopLoadDiagnosticSummary(certificationRoot, binding)
  if (
    !diagnostics.includes("activation_marker_verified=passed") ||
    !diagnostics.includes("daemon_cleanup_verified=passed")
  ) {
    throw new Error("Packed plugin host proof diagnostics are incomplete")
  }
  await recordStage("daemon-cleanup-completed")
  if (officialEvidence !== undefined) {
    if (runtimeEvidence === undefined || dependencyTreeEvidence === undefined) {
      throw new Error("Official Electron runtime evidence material was not captured")
    }
    const receipt = runtimeEvidence.receipt
    await recordStage("evidence-publishing")
    const publication = await officialEvidence.publish({
      binding: {
        electronVersion: receipt.electronVersion,
        nativePackageSha256: binding.nativePackageSha256,
        nodeVersion: receipt.nodeVersion,
        pluginPackageSha256: binding.pluginPackageSha256,
        revision: binding.revision,
        runtimeExecutableSha256: receipt.runtimeExecutableSha256,
        runtimeProductVersion: receipt.runtimeProductVersion,
      },
      gateOutput: gateOutput.summary(),
      material: {
        "dependency-tree-manifest.json": dependencyTreeEvidence,
        "desktop-runtime-diagnostics.jsonl": runtimeEvidence.diagnostics,
        "desktop-runtime-provenance.json": serializeOfficialRuntimeProvenance({
          candidateEntry: runtimeEvidence.candidateEntry,
          linker: runtimeEvidence.linker,
          loader: runtimeEvidence.loader,
        }),
        "desktop-runtime-result.json": runtimeEvidence.result,
        "runtime-output-summary.json": jsonLine({
          exitCode: runtimeEvidence.execution.exitCode,
          outputExceeded: runtimeEvidence.execution.outputExceeded,
          schemaVersion: 1,
          stderrBytes: runtimeEvidence.execution.stderr.byteLength,
          stderrSha256: digestBytes(runtimeEvidence.execution.stderr),
          stdoutBytes: runtimeEvidence.execution.stdout.byteLength,
          stdoutSha256: digestBytes(runtimeEvidence.execution.stdout),
          timedOut: runtimeEvidence.execution.timedOut,
          type: "opencode-cycle-official-electron-runtime-output",
        }),
        "runtime-receipt.json": jsonLine(receipt),
      },
    })
    if (!publication.passed) throw new PackageGateFailure("evidence_publication")
  }
} catch (error) {
  if (officialEvidence !== undefined) {
    const errorClass = classifyPackageGateFailure(error)
    await officialEvidence.recordStage("gate-failed", {
      errorClass,
      failedStage: currentStage,
    }).catch(() => undefined)
    await officialEvidence.finalizeFailure({
      errorClass,
      errorDigest: digestOfficialEvidenceError(error),
      gateOutput: gateOutput.summary(),
      ...(revision === undefined ? {} : { revision }),
    }).catch((failure: unknown) => {
      // A gate that dies before its first stage cannot publish a valid receipt.
      // Reporting that instead of the failure it was recording would hide the
      // reason the gate died, so it is surfaced alongside and never in place.
      console.error("Official Electron evidence failure receipt was not published:", failure)
    })
  }
  throw error
} finally {
  if (proof !== undefined && proof.exitCode === null && scratch !== undefined && launcherStop !== undefined) {
    const release = join(scratch, "certification", "host-proof-release")
    await writeFile(release, "release\n", { flag: "wx" }).catch(() => undefined)
    await Promise.race([proof.exited, Bun.sleep(2_000)])
    if (proof.exitCode === null) {
      await writeFile(launcherStop, "stop\n", { flag: "wx" }).catch(() => undefined)
      await proof.exited
    }
  }
  await Promise.all([
    ...(scratch === undefined ? [] : [rm(scratch, { force: true, recursive: true })]),
    ...(launcherTemporary === undefined
      ? []
      : [rm(launcherTemporary, { force: true, recursive: true })]),
  ])
}

/**
 * Mirror a child's diagnostics for an operator watching a long gate.
 *
 * This is a convenience, never evidence. Writing to this process's own stderr
 * can fail with a broken pipe depending on how the gate was invoked, and an
 * unguarded write turned that into a failed release gate part way through an
 * otherwise healthy run. The captured bytes are still recorded and bounded by
 * the gate output; only the echo is best effort.
 */
function forwardGateDiagnostics(value: Uint8Array): void {
  try {
    process.stderr.write(value)
  } catch {
    // An operator loses the live echo; the gate keeps its evidence and runs on.
  }
}

async function readGateOutput(
  stream: ReadableStream<Uint8Array>,
  channel: "stderr" | "stdout",
  child: { kill: () => void },
): Promise<Buffer> {
  const chunks: Buffer[] = []
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!gateOutput.capture(channel, value)) {
        child.kill()
        throw new PackageGateFailure("output_limit")
      }
      if (channel === "stderr") forwardGateDiagnostics(value)
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

async function recordStage(
  stage: string,
  details: Readonly<Record<string, boolean | number | string | null>> = {},
): Promise<void> {
  currentStage = stage
  await officialEvidence?.recordStage(stage, details)
}

function classifyPackageGateFailure(error: unknown): string {
  if (error instanceof PackageGateFailure) return error.errorClass
  if (error instanceof Error && error.message.includes("endpoint_path")) return "endpoint_path"
  if (runtimeFailureClass !== undefined && runtimeFailureClass !== "none") return runtimeFailureClass
  if (
    currentStage.startsWith("runtime-") || currentStage.startsWith("module-") ||
    currentStage === "held-tree-verified"
  ) return "runtime_guard"
  if (currentStage.startsWith("host-")) return "host_proof"
  if (currentStage.startsWith("native-build")) return "native_build"
  if (currentStage.startsWith("native-package")) return "native_package"
  if (currentStage.startsWith("dependency-tree")) return "dependency_tree"
  if (currentStage.startsWith("evidence-")) return "evidence_publication"
  return "package_error"
}

async function recordHostDiagnosticStages(
  root: string,
  binding: DesktopCertificationBinding,
): Promise<void> {
  if (officialEvidence === undefined) return
  const diagnostics = await desktopLoadDiagnosticStages(root, binding)
  for (const diagnostic of diagnostics.slice(reportedHostDiagnosticCount)) {
    await recordStage(`host-${diagnostic.stage.replaceAll("_", "-")}`, {
      sequence: diagnostic.sequence,
      status: diagnostic.status,
    })
  }
  reportedHostDiagnosticCount = diagnostics.length
}

async function digest(path: string): Promise<string> {
  return digestBytes(Buffer.from(await Bun.file(path).arrayBuffer()))
}

function environmentPath(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]
  if (value === undefined || !isAbsolute(value)) throw new Error(`Missing absolute ${name}`)
  return resolve(value)
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}
