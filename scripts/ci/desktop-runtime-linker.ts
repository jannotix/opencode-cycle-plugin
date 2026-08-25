import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

export interface DesktopRuntimeLinkerExpected {
  readonly authoritative: boolean
  readonly candidateEntry: string
  readonly candidateEntrySha256: string
  readonly dependencyTreeSha256: string
  readonly electronVersion: string | null
  readonly fullTreeFileCount: number
  readonly installedPlugin: string
  readonly nodeVersion: string
  readonly resultFile: string
  readonly runtimeInputContentBytes: number
  readonly runtimeInputFileCount: number
  readonly runtimeInputSerializedBytes: number
  readonly runtimeInputSha256: string
  readonly runtimeExecutableSha256: string
  readonly runtimeProductVersion: string
  readonly verifiedContentTreeSha256: string
}

export function desktopRuntimeLinkerSource(
  expected: DesktopRuntimeLinkerExpected,
  runtimeImport = "./desktop-runtime-linker-runtime.js",
): string {
  return `import { runDesktopRuntimeLinker } from ${JSON.stringify(runtimeImport)}\n` +
    `await runDesktopRuntimeLinker(${JSON.stringify(expected)})\n`
}

export async function bundledDesktopRuntimeLinker(
  expected: DesktopRuntimeLinkerExpected,
): Promise<Buffer> {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-desktop-linker-build-"))
  try {
    const entry = join(temporary, "entry.mjs")
    const runtime = resolve(import.meta.dir, "desktop-runtime-linker-runtime.ts")
    let runtimeImport = relative(dirname(entry), runtime).split(sep).join("/")
    if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`
    const acornRoot = resolve(import.meta.dir, "../..", "node_modules", "acorn")
    const acornManifest = JSON.parse(
      await readFile(resolve(acornRoot, "package.json"), "utf8"),
    ) as { readonly license?: unknown; readonly version?: unknown }
    if (acornManifest.version !== "8.15.0" || acornManifest.license !== "MIT") {
      throw new Error("Trusted Desktop linker parser pin changed")
    }
    const acornLicense = await readFile(resolve(acornRoot, "LICENSE"), "utf8")
    await writeFile(entry, desktopRuntimeLinkerSource(expected, runtimeImport), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    const output = join(temporary, "desktop-runtime-linker.mjs")
    const child = Bun.spawn([
      process.execPath,
      "build",
      entry,
      "--format=esm",
      "--outfile",
      output,
      "--sourcemap=none",
      "--target=node",
    ], { stderr: "pipe", stdout: "ignore", windowsHide: true })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (exitCode !== 0) throw new Error(`Trusted Desktop linker bundle failed: ${safeBuildFailure(stderr)}`)
    return Buffer.concat([
      Buffer.from(`/* Bundled dependency: acorn@8.15.0\n${acornLicense}*/\n`),
      await readFile(output),
    ])
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}

function safeBuildFailure(stderr: string): string {
  const sanitized = stderr.replace(/[A-Za-z]:[^\s;]*/gu, "<path>").trim()
  return sanitized.length === 0 ? "no diagnostic" : sanitized
}
