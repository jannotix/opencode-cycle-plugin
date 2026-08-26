import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { NATIVE_PACKAGE_NAMES } from "../product-identity.js"
import { inspectTarGz } from "./tar-archive.js"

export const NATIVE_TARGETS = {
  "darwin-arm64": { cpu: "arm64", executable: "workflowd", os: "darwin" },
  "darwin-x64": { cpu: "x64", executable: "workflowd", os: "darwin" },
  "linux-x64": { cpu: "x64", executable: "workflowd", os: "linux" },
  "win32-x64": { cpu: "x64", executable: "workflowd.exe", os: "win32" },
} as const

export type NativeTarget = keyof typeof NATIVE_TARGETS

export interface NativePackageResult {
  readonly archive: string
  readonly checksum: string
}

export async function packageNative(
  root: string,
  target: NativeTarget,
  binary: string,
  output: string,
): Promise<NativePackageResult> {
  const definition = NATIVE_TARGETS[target]
  const resolvedRoot = resolve(root)
  const packageName = NATIVE_PACKAGE_NAMES.find((name) => name.endsWith(`/native-${target}`))
  if (packageName === undefined) throw new Error(`Native package identity is unsupported: ${target}`)
  const sourcePackage = join(resolvedRoot, "packages", packageName.slice(packageName.lastIndexOf("/") + 1))
  const scratch = await mkdtemp(join(tmpdir(), "opencode-cycle-native-"))
  const stage = join(scratch, "package")
  const extracted = join(scratch, "extracted")
  const resolvedOutput = resolve(output)
  try {
    await mkdir(join(stage, "bin"), { recursive: true })
    await mkdir(extracted)
    await mkdir(resolvedOutput, { recursive: true })
    await Promise.all([
      copyFile(join(sourcePackage, "package.json"), join(stage, "package.json")),
      copyFile(join(resolvedRoot, "LICENSE"), join(stage, "LICENSE")),
      copyFile(join(resolvedRoot, "NOTICE"), join(stage, "NOTICE")),
      copyFile(resolve(binary), join(stage, "bin", definition.executable)),
    ])
    await run(["bun", "pm", "pack", "--destination", resolvedOutput], stage)
    const archives = (await readdir(resolvedOutput)).filter((name) => name.endsWith(".tgz"))
    if (archives.length !== 1) throw new Error("Native packaging must produce exactly one archive")
    const archive = join(resolvedOutput, archives[0] as string)
    const listing = inspectTarGz(await readFile(archive)).map((entry) => entry.name).sort()
    const expected = [
      "package/LICENSE",
      "package/NOTICE",
      `package/bin/${definition.executable}`,
      "package/package.json",
    ].sort()
    if (JSON.stringify(listing) !== JSON.stringify(expected)) {
      throw new Error(`Native archive allowlist mismatch: ${listing.join(", ")}`)
    }
    await run(["tar", "-xf", archive, "-C", extracted], resolvedRoot)
    const [sourceDigest, packedDigest] = await Promise.all([
      digest(resolve(binary)),
      digest(join(extracted, "package", "bin", definition.executable)),
    ])
    if (sourceDigest !== packedDigest) throw new Error("Packed native binary digest changed")
    const manifest = JSON.parse(
      await readFile(join(extracted, "package", "package.json"), "utf8"),
    ) as Record<string, unknown>
    if (
      JSON.stringify(manifest.os) !== JSON.stringify([definition.os]) ||
      JSON.stringify(manifest.cpu) !== JSON.stringify([definition.cpu]) ||
      manifest.dependencies !== undefined ||
      manifest.scripts !== undefined
    ) {
      throw new Error("Packed native manifest is not platform-bound or minimal")
    }
    const checksum = await digest(archive)
    await writeFile(`${archive}.sha256`, `${checksum}  ${basename(archive)}\n`, "utf8")
    return { archive, checksum }
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function run(command: readonly string[], directory: string): Promise<string> {
  const child = Bun.spawn([...command], { cwd: directory, stderr: "inherit", stdout: "pipe" })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`)
  return output
}
