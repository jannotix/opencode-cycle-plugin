import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { packageNative, type NativeTarget } from "../packaging/native-package.js"
import { PRODUCT_IDENTITY } from "../product-identity.js"

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
  const module = await import(pathToFileURL(join(installedPackage, "dist", "index.js")).href)
  if (typeof module.default !== "function" || Object.keys(module).some((key) => key !== "default")) {
    throw new Error("Packed plugin does not export the OpenCode plugin entrypoint")
  }
  const client = await import(pathToFileURL(join(installedPackage, "dist", "client.js")).href)
  const controlPlane = new client.LocalControlPlane({
    dataDirectory: join(scratch, "runtime-data"),
    stopOwnedProcessOnDispose: true,
  })
  try {
    const health = await controlPlane.health()
    if (health.protocol_version !== 1 || health.schema_version !== 17) {
      throw new Error("Installed plugin and native package failed the health contract")
    }
  } finally {
    await controlPlane.dispose()
  }
} finally {
  await rm(scratch, { force: true, recursive: true })
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(Buffer.from(await Bun.file(path).arrayBuffer()))
    .digest("hex")
}
