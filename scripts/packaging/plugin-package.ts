import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { PRODUCT_IDENTITY } from "../product-identity.js"
import { inspectTarGz } from "./tar-archive.js"

const GENERATED_RUNTIME_MODULES = ["browser/managed-browser-session.cjs"] as const

const NON_PRODUCTION_PATH =
  /(?:^|\/)(?:(?:test|tests|example|examples|fixture|fixtures|debug|coverage|docs|\.github)(?:\/|$)|[^/]*(?:\.(?:test|spec)(?:\.|$)|_(?:test|spec)_)[^/]*)|\.map$/iu

export interface PluginPackageResult {
  readonly archive: string
  readonly checksum: string
}

export async function packagePlugin(root: string, output: string): Promise<PluginPackageResult> {
  const resolvedRoot = resolve(root)
  const packageRoot = join(resolvedRoot, "packages", PRODUCT_IDENTITY.mainPackage)
  const resolvedOutput = resolve(output)
  const scratch = await mkdtemp(join(tmpdir(), "opencode-cycle-plugin-package-"))
  const comparison = join(scratch, "comparison")
  try {
    await Promise.all([mkdir(resolvedOutput, { recursive: true }), mkdir(comparison)])
    const sourceModules = (await readdir(join(packageRoot, "src"), { recursive: true }))
      .filter((path) => path.endsWith(".ts"))
      .map((path) => path.replaceAll("\\", "/").replace(/\.ts$/u, ".js"))
    validatePluginSourceModules(sourceModules)
    await cleanPluginBuildOutput(packageRoot)
    await run(["bun", "pm", "pack", "--destination", resolvedOutput], packageRoot)
    await cleanPluginBuildOutput(packageRoot)
    await run(["bun", "pm", "pack", "--destination", comparison], packageRoot)
    const archiveName = await singleArchive(resolvedOutput)
    const comparisonName = await singleArchive(comparison)
    const archive = join(resolvedOutput, archiveName)
    if ((await digest(archive)) !== (await digest(join(comparison, comparisonName)))) {
      throw new Error("Plugin package is not reproducible from identical inputs")
    }
    const listing = inspectTarGz(await readFile(archive)).map((entry) => entry.name)
    validatePluginListing(listing, sourceModules, GENERATED_RUNTIME_MODULES)
    const checksum = await digest(archive)
    await writeFile(`${archive}.sha256`, `${checksum}  ${basename(archive)}\n`, "utf8")
    return { archive, checksum }
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }
}

export async function cleanPluginBuildOutput(packageRoot: string): Promise<void> {
  const resolvedPackageRoot = resolve(packageRoot)
  await Promise.all([
    rm(join(resolvedPackageRoot, "dist"), { force: true, recursive: true }),
    rm(join(resolvedPackageRoot, "..", "..", "target", "typescript", "opencode-cycle.tsbuildinfo"), {
      force: true,
    }),
  ])
}

export function validatePluginListing(
  listing: readonly string[],
  sourceModules: readonly string[],
  generatedRuntimeModules: readonly string[] = [],
): void {
  const unique = new Set(listing)
  if (unique.size !== listing.length) {
    throw new Error("Plugin package contains a duplicate archive member")
  }
  const forbiddenPath = listing.find(isNonProductionPath)
  if (forbiddenPath !== undefined) {
    throw new Error(`Plugin package contains non-production file ${forbiddenPath}`)
  }
  validatePluginSourceModules(sourceModules)
  const expected = [
    "package/LICENSE",
    "package/NOTICE",
    "package/package.json",
    ...sourceModules.map((path) => `package/dist/${path}`),
    ...generatedRuntimeModules.map((path) => `package/dist/${path}`),
  ].sort()
  const actual = [...listing].sort()
  const unexpected = actual.find((path) => !expected.includes(path))
  if (unexpected !== undefined) throw new Error(`Plugin package contains non-production file ${unexpected}`)
  const missing = expected.find((path) => !actual.includes(path))
  if (missing !== undefined) throw new Error(`Plugin package is missing ${missing}`)
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error("Plugin package members do not equal the unique sorted production allowlist")
  }
}

export function validatePluginSourceModules(sourceModules: readonly string[]): void {
  const forbiddenPath = sourceModules.find(isNonProductionPath)
  if (forbiddenPath !== undefined) {
    throw new Error(`Plugin source contains non-production module ${forbiddenPath}`)
  }
}

function isNonProductionPath(path: string): boolean {
  return NON_PRODUCTION_PATH.test(path.replaceAll("\\", "/"))
}

async function singleArchive(directory: string): Promise<string> {
  const archives = (await readdir(directory)).filter((name) => name.endsWith(".tgz"))
  if (archives.length !== 1) throw new Error("Plugin packaging must produce exactly one archive")
  return archives[0] as string
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
