import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

import { packageNative } from "../packaging/native-package.js"
import { PRODUCT_IDENTITY } from "../product-identity.js"
import { openDesktopDependencyTreeVerification } from "./desktop-dependency-tree.js"
import { bundledDesktopRuntimeLinker } from "./desktop-runtime-linker.js"

test.skipIf(process.platform !== "win32")(
  "real packed Windows tree minimizes 5,931 held files without changing the verified graph",
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const temporary = await mkdtemp(join(tmpdir(), "cycle-real-runtime-input-"))
    const extracted = join(temporary, "extracted")
    const nativeOutput = join(temporary, "native")
    try {
      await Promise.all([mkdir(extracted), mkdir(nativeOutput)])
      await run(["cargo", "build", "-p", "workflowd", "--release"], root)
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
      await run(["tar", "-xf", join(temporary, archiveName as string), "-C", extracted], root)
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
        expect(input.fullTreeFileCount).toBe(5_931)
        expect(input.runtimeInputFileCount).toBe(2_774)
        expect(input.runtimeInputSerializedBytes).toBe(25_382_223)
        expect(input.runtimeInputSerializedBytes).toBeLessThan(input.fullTreeSerializedBytes)
        expect(input.runtimeInputSha256).toMatch(/^[0-9a-f]{64}$/u)

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
        expect(result).toMatchObject({
          fullTreeFileCount: 5_931,
          graphFileCount: 132,
          graphSha256: "34e8cf6436e269cd37a7758b62cc3a1c4e7530c8106f48a0b3e85d12b8e6ea2c",
          linkedEsmModuleCount: 130,
          runtimeInputFileCount: input.runtimeInputFileCount,
          runtimeInputSerializedBytes: input.runtimeInputSerializedBytes,
          runtimeInputSha256: input.runtimeInputSha256,
          verifiedAssetFileCount: 1,
          verifiedCommonJsModuleCount: 1,
          verifiedJsonModuleCount: 0,
        })
        await verification.verifyAndClose()
      } finally {
        await input.close()
        await verification.abort()
      }
    } finally {
      await rm(temporary, { force: true, recursive: true })
    }
  },
  { timeout: 5 * 60_000 },
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
