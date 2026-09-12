import { beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

import { packageNative } from "../packaging/native-package.js"
import { PRODUCT_IDENTITY } from "../product-identity.js"
import {
  openDesktopDependencyTreeVerification,
  parseDesktopDependencyTreeManifest,
  serializeDesktopDependencyTreeManifest,
} from "./desktop-dependency-tree.js"
import { bundledDesktopRuntimeLinker } from "./desktop-runtime-linker.js"
import { systemTarExecutable } from "../system-tar.js"

// Building the release daemon is environment preparation, not the property
// under test: on a cold tree it is a full optimized Rust build, while on a
// warm tree it is a no-op. Keeping it outside the test body lets the proof
// below carry a budget that means something.
beforeAll(async () => {
  if (process.platform !== "win32") return
  await run(["cargo", "build", "-p", "workflowd", "--release"], fileURLToPath(new URL("../../", import.meta.url)))
}, 30 * 60_000)

test.skipIf(process.platform !== "win32")(
  "real packed Windows tree minimizes 5,934 held files with a truthful verified graph",
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const temporary = await mkdtemp(join(tmpdir(), "cycle-real-runtime-input-"))
    const extracted = join(temporary, "extracted")
    const nativeOutput = join(temporary, "native")
    try {
      await Promise.all([mkdir(extracted), mkdir(nativeOutput)])
      const native = await packageNative(
        root,
        "win32-x64",
        join(root, "target", "release", "workflowd.exe"),
        nativeOutput,
      )
      const packageRoot = join(root, "packages", PRODUCT_IDENTITY.mainPackage)
      await run(["bun", "pm", "pack", "--destination", temporary], packageRoot)
      const archiveName = (await readdir(temporary)).find((name) => name.endsWith(".tgz"))
      expect(archiveName).toBeString()
      await run([systemTarExecutable(), "-xf", join(temporary, archiveName as string), "-C", extracted], root)
      const installedPlugin = join(extracted, "package")
      await run([
        "bun",
        "install",
        "--backend=copyfile",
        "--ignore-scripts",
        "--linker=hoisted",
        "--production",
        "--no-save",
        native.archive,
      ], installedPlugin)
      await mkdir(join(installedPlugin, "bin"))
      await copyFile(
        join(root, "target", "release", "workflowd.exe"),
        join(installedPlugin, "bin", "workflowd.exe"),
      )

      const verification = await openDesktopDependencyTreeVerification(installedPlugin)
      const input = verification.openLinkerInput()
      try {
        expect(verification.receipt.dependencyFileCount).toBe(5_885)
        expect(input.fullTreeFileCount).toBeGreaterThan(5_900)
        expect(input.runtimeInputFileCount).toBeLessThan(3_000)
        expect(input.runtimeInputSerializedBytes).toBeLessThan(64 * 1024 * 1024)
        expect(input.runtimeInputSerializedBytes).toBeLessThan(input.fullTreeSerializedBytes)
        expect(input.runtimeInputSha256).toMatch(/^[0-9a-f]{64}$/u)
        const dependencyManifest = serializeDesktopDependencyTreeManifest({
          contentTreeSha256: verification.contentTreeSha256,
          dependencyTree: verification.receipt,
          files: verification.contentManifest,
        })
        expect(dependencyManifest.byteLength).toBeLessThan(16 * 1024 * 1024)
        expect(parseDesktopDependencyTreeManifest(dependencyManifest).files)
          .toHaveLength(input.fullTreeFileCount)

        // The bytes this repository ships, which is the only part of the tree it can promise.
        // Everything under node_modules is resolved from the registry at install time — the packed
        // package carries no lockfile, and puppeteer-core declares two of its dependencies as caret
        // ranges over packages that ship JavaScript — so a total over the whole tree moves when a
        // third party publishes, not when anything here changes. It did: between 2026-09-04 and
        // 2026-09-12 the totals moved by 36,268 bytes with no shipped file touched.
        //
        // This is the same distinction the graph digest already carries below. Drift detection for
        // our own code belongs on our own code; the third-party share stays bounded by the limits
        // above rather than pinned to whatever the registry returned on the day it was measured.
        const shippedBytes = verification.contentManifest
          .filter((file) => file.path.startsWith("dist/"))
          .reduce((total, file) => total + Number(file.identity.size), 0)

        const entry = join(installedPlugin, "dist", "index.js")
        const resultFile = join(temporary, "result.json")
        const linker = join(temporary, "linker.mjs")
        const runtimeExecutableSha256 = await digest(process.execPath)
        await writeFile(linker, await bundledDesktopRuntimeLinker({
          authoritative: false,
          candidateEntry: entry,
          candidateEntrySha256: await digest(entry),
          dependencyTreeSha256: verification.receipt.dependencyTreeSha256,
          electronVersion: null,
          fullTreeFileCount: input.fullTreeFileCount,
          installedPlugin,
          nodeVersion: process.versions.node,
          resultFile,
          runtimeExecutableSha256,
          runtimeInputContentBytes: input.runtimeInputContentBytes,
          runtimeInputFileCount: input.runtimeInputFileCount,
          runtimeInputSerializedBytes: input.runtimeInputSerializedBytes,
          runtimeInputSha256: input.runtimeInputSha256,
          runtimeProductVersion: "system-node-real-packed-proof",
          verifiedContentTreeSha256: verification.contentTreeSha256,
        }), { flag: "wx", mode: 0o600 })
        const linkerStartedAt = Date.now()
        const child = spawn(process.execPath, [
          "--no-warnings",
          "--experimental-vm-modules",
          linker,
        ], { cwd: temporary, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
        const transfer = pipeline(input.createReadStream(), child.stdin!)
        const exited = new Promise<number>((resolveExit, reject) => {
          child.once("error", reject)
          child.once("exit", (code) => resolveExit(code ?? 1))
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          exited,
          readText(child.stdout!),
          readText(child.stderr!),
          transfer,
        ]).then(([code, standardOutput, standardError]) =>
          [code, standardOutput, standardError] as const)
        expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "" })
        expect(Date.now() - linkerStartedAt).toBeLessThan(30_000)
        const result = JSON.parse(await readFile(resultFile, "utf8")) as Record<string, unknown>
        expect({
          fullTreeFileCount: input.fullTreeFileCount,
          graphFileCount: result.graphFileCount,
          graphSha256: result.graphSha256,
          linkedEsmModuleCount: result.linkedEsmModuleCount,
          runtimeInputFileCount: input.runtimeInputFileCount,
          shippedBytes,
        }).toEqual({
          fullTreeFileCount: 5_934,
          graphFileCount: 44,
          // Environment-bound values are asserted for shape, not value. The graph digest covers
          // the native binary as a verified asset, and an optimized Rust build is not
          // byte-reproducible across build directories. The runtime-input byte totals cover
          // third-party JavaScript resolved from the registry, for the reason given above. Drift
          // detection lives in the counts, the module kinds, and `shippedBytes` — all of which are
          // properties of this repository rather than of the day the test ran.
          graphSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          linkedEsmModuleCount: 42,
          runtimeInputFileCount: 2_777,
          // Measured. It moves when the shipped JavaScript changes, which is the point; update it
          // from a manifest diff that names the files responsible.
          // Each step names the shipped files it moved. 2,303,378 until the repair feedback learned
          // to carry the rejecting reviewer's findings, which grew
          // `dist/orchestration/full-workflow.js` by 1,373; then 2,304,751 until the arbiter prompt
          // stated the binding rule, which grew `dist/orchestration/arbiter.js` by 405; then
          // 2,305,156 until the repair bound came from the plane and the delegation deny stopped
          // hanging on one key, which grew `full-workflow.js`, `permissions.js`, `index.js` and
          // `commands/setup.js` by 3,175 between them.
          shippedBytes: 2_308_331,
        })
        expect(result).toMatchObject({
          isolatedRuntimeBoundaryCount: 1,
          moduleLoadingProof: "static-literal-plugin-host-with-isolated-worker-v1",
          runtimeInputSha256: input.runtimeInputSha256,
          // This Windows tree resolves its own native package and suppresses
          // the three optional roots for the platforms it is not: linux-x64,
          // darwin-x64 and darwin-arm64. Suppression is confined to declared,
          // entirely absent optional roots, so a broken or partially installed
          // native package still fails the graph instead of being skipped.
          suppressedOptionalRootCount: 3,
          unverifiedPluginHostModuleLoadingRejected: true,
          verifiedAssetFileCount: 2,
          verifiedCommonJsModuleCount: 0,
          verifiedJsonModuleCount: 0,
        })
        expect(result.isolatedRuntimeBoundarySha256).toBe(await digest(join(
          installedPlugin, "dist", "browser", "managed-browser-worker.mjs",
        )))
        await verification.verifyAndClose()
      } finally {
        await input.close()
        await verification.abort()
      }
    } finally {
      await rm(temporary, { force: true, recursive: true })
    }
  },
  // Envelope for pack, install, hash and link of the 5,933-file real tree on
  // a loaded Windows machine, with the release build already prepared above.
  // The security-relevant bound stays the strict 30-second linker assertion
  // inside the test.
  { timeout: 10 * 60_000 },
)

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe", windowsHide: true })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`Real packed runtime input command failed: ${createHash("sha256")
      .update(stdout).update("\0").update(stderr).digest("hex")}`)
  }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(Buffer.from(await Bun.file(path).arrayBuffer())).digest("hex")
}

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString("utf8")
}
