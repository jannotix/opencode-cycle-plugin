import { createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { DesktopCertificationBinding } from "../../packages/opencode-cycle/src/certification.js"
import { packageNative, type NativeTarget } from "../packaging/native-package.js"
import { PRODUCT_IDENTITY } from "../product-identity.js"
import { cleanupCertifiedDaemon } from "./certified-daemon.js"
import {
  certificationEnvironment,
  completeDesktopDaemonCleanupDiagnostic,
  desktopLoadDiagnosticSummary,
  prepareDesktopCertificationLoad,
  waitForDesktopActivation,
} from "./desktop-certification.js"
import { OPENCODE_11821_HOST_PROOF_PROVENANCE, type OpenCodeHostProofReceipt } from "./opencode-1.18.21-host-proof.js"

const root = fileURLToPath(new URL("../../", import.meta.url))
const packageRoot = join(root, "packages", PRODUCT_IDENTITY.mainPackage)
const scratch = await mkdtemp(join(tmpdir(), "opencode-cycle-packed-plugin-"))
const extracted = join(scratch, "extracted")
const nativeArtifacts = join(scratch, "native")
const secondPack = join(scratch, "second-pack")

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stderr: "inherit", stdout: "pipe" })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`)
  return output
}

await mkdir(extracted, { recursive: true })
await mkdir(secondPack, { recursive: true })
try {
  const nativeTarget = `${process.platform}-${process.arch}` as NativeTarget
  const executable = process.platform === "win32" ? "workflowd.exe" : "workflowd"
  const native = await packageNative(
    root,
    nativeTarget,
    join(root, "target", "debug", executable),
    nativeArtifacts,
  )
  await run(["bun", "pm", "pack", "--destination", scratch], packageRoot)
  const archiveName = (await readdir(scratch)).find((name) => name.endsWith(".tgz"))
  if (archiveName === undefined) throw new Error("Plugin pack did not produce an archive")
  const archive = join(scratch, archiveName)
  await run(["bun", "pm", "pack", "--destination", secondPack], packageRoot)
  const secondArchiveName = (await readdir(secondPack)).find((name) => name.endsWith(".tgz"))
  if (secondArchiveName === undefined) throw new Error("Second plugin pack did not produce an archive")
  if ((await digest(archive)) !== (await digest(join(secondPack, secondArchiveName)))) {
    throw new Error("Plugin package is not reproducible from identical inputs")
  }
  const listing = (await run(["tar", "-tf", archive], root)).split(/\r?\n/u).filter(Boolean)
  for (const required of ["package/package.json", "package/dist/index.js", "package/LICENSE", "package/NOTICE"]) {
    if (!listing.includes(required)) throw new Error(`Packed plugin is missing ${required}`)
  }
  const unexpected = listing.find(
    (path) =>
      !["package/package.json", "package/LICENSE", "package/NOTICE"].includes(path) &&
      !/^package\/dist\/(?:[^/]+\/)*[^/]+\.js$/u.test(path),
  )
  if (unexpected !== undefined) {
    throw new Error(`Packed plugin contains non-production file ${unexpected}`)
  }

  await run(["tar", "-xf", archive, "-C", extracted], root)
  const installedPackage = join(extracted, "package")
  await run(
    ["bun", "install", "--ignore-scripts", "--production", "--no-save", native.archive],
    installedPackage,
  )
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64"
  const certificationRoot = join(scratch, "certification")
  const dataDirectory = join(scratch, "runtime-data")
  const project = join(scratch, "project")
  await Promise.all([mkdir(certificationRoot), mkdir(project)])
  const binding: DesktopCertificationBinding = {
    nativePackageSha256: native.checksum,
    nonce: randomBytes(32).toString("hex"),
    pluginPackageSha256: await digest(archive),
    revision: (await run(["git", "rev-parse", "HEAD"], root)).trim(),
    root: certificationRoot,
    startedAtUnixMillis: Date.now(),
  }
  const environment = certificationEnvironment(scratch, platform, process.env, binding)
  const prepared = await prepareDesktopCertificationLoad({
    certification: binding,
    dataDirectory,
    environment,
    hostVersion: "1.18.21",
    nativeExecutable: join(root, "target", "debug", executable),
    packedPlugin: installedPackage,
    platform,
    scratch,
  })
  const proofRequest = join(scratch, "host-proof-request.json")
  const proofResult = join(scratch, "host-proof-result.json")
  await writeFile(proofRequest, `${JSON.stringify({
    binding,
    candidatePackageRoot: prepared.installedPlugin,
    configFile: prepared.configFile,
    directory: project,
    resultFile: proofResult,
    worktree: project,
  })}\n`)
  const proof = Bun.spawn(
    [process.execPath, join(root, "scripts", "ci", "opencode-1.18.21-host-proof.ts"), "--request", proofRequest],
    { cwd: scratch, env: environment, stderr: "ignore", stdout: "ignore" },
  )
  if ((await proof.exited) !== 0) throw new Error("Packed plugin failed the OpenCode 1.18.21 host proof")
  const hostReceipt = JSON.parse(await readFile(proofResult, "utf8")) as OpenCodeHostProofReceipt
  if (
    hostReceipt.provenanceCommit !== OPENCODE_11821_HOST_PROOF_PROVENANCE.commit ||
    hostReceipt.mergedOrigins !== 3 ||
    hostReceipt.deduplicatedOrigins !== 1 ||
    hostReceipt.loadedPlugins !== 1 ||
    !hostReceipt.tupleOptions
  ) throw new Error("Packed plugin host proof receipt is invalid")
  await waitForDesktopActivation(certificationRoot, binding, 5_000)
  const cleanup = await cleanupCertifiedDaemon({
    binding,
    environment,
    expectedBinaryPath: join(prepared.installedPlugin, "bin", executable),
    platform,
  })
  if (!cleanup.markerPublished) throw new Error("Packed plugin did not publish daemon ownership")
  await completeDesktopDaemonCleanupDiagnostic(prepared.diagnosticsFile, binding, "passed")
  const diagnostics = await desktopLoadDiagnosticSummary(certificationRoot, binding)
  if (
    !diagnostics.includes("activation_marker_verified=passed") ||
    !diagnostics.includes("daemon_cleanup_verified=passed")
  ) {
    throw new Error("Packed plugin host proof diagnostics are incomplete")
  }
} finally {
  await rm(scratch, { force: true, recursive: true })
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(Buffer.from(await Bun.file(path).arrayBuffer()))
    .digest("hex")
}
