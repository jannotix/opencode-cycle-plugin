import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DESKTOP_ASSET_METADATA } from "../release/release-manifest.js"
import { desktopRuntimeLinkerSource } from "./desktop-runtime-linker.js"

test("trusted module linker links the graph without evaluating candidate code", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-link-only-"))
  try {
    const installedPlugin = join(temporary, "opencode-cycle")
    const entry = join(installedPlugin, "dist", "index.js")
    const sideEffect = join(temporary, "candidate-evaluated")
    const resultFile = join(temporary, "result.json")
    await mkdir(join(installedPlugin, "dist"), { recursive: true })
    await Promise.all([
      writeFile(join(installedPlugin, "package.json"), `${JSON.stringify({
        exports: { ".": "./dist/index.js" },
        type: "module",
      })}\n`),
      writeFile(join(installedPlugin, "dist", "dependency.js"), "export const linked = true\n"),
      writeFile(join(installedPlugin, "dist", "lazy.js"), "export default 'linked-only'\n"),
      writeFile(entry, [
        "import { writeFileSync } from 'node:fs'",
        "import { linked } from './dependency.js'",
        `writeFileSync(${JSON.stringify(sideEffect)}, String(linked))`,
        "process.exit(0)",
        "const lazy = () => import('./lazy.js')",
        "export default () => linked && lazy",
      ].join("\n")),
    ])
    const execution = await runLinker({ entry, installedPlugin, resultFile })
    expect(execution).toEqual({ exitCode: 0, stderr: "", stdout: "" })
    expect(await readFile(sideEffect).then(() => true, () => false)).toBe(false)
    const result = JSON.parse(await readFile(resultFile, "utf8")) as Record<string, unknown>
    expect(result).toMatchObject({
      candidateDefaultExportLinked: true,
      candidateEvaluated: false,
      unsafeDynamicImportsRejected: true,
      graphFileCount: 3,
      linkedModuleCount: 4,
      type: "opencode-cycle-desktop-module-link",
    })
    expect(result.graphSha256).toMatch(/^[0-9a-f]{64}$/u)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})

test("trusted module linker rejects Bun builtins, dynamic imports and unresolved modules", async () => {
  for (const [label, source] of [
    ["bun", "import { spawn } from 'bun'; export default spawn\n"],
    ["dynamic", "export default (name) => import('./' + name)\n"],
    ["unresolved", "import value from './absent.js'; export default value\n"],
  ] as const) {
    const temporary = await mkdtemp(join(tmpdir(), `cycle-link-${label}-`))
    try {
      const installedPlugin = join(temporary, "opencode-cycle")
      const entry = join(installedPlugin, "dist", "index.js")
      const resultFile = join(temporary, "result.json")
      await mkdir(join(installedPlugin, "dist"), { recursive: true })
      await Promise.all([
        writeFile(join(installedPlugin, "package.json"), `${JSON.stringify({
          exports: { ".": "./dist/index.js" },
          type: "module",
        })}\n`),
        writeFile(entry, source),
      ])
      const execution = await runLinker({ entry, installedPlugin, resultFile })
      expect(execution.exitCode).not.toBe(0)
      expect(await readFile(resultFile).then(() => true, () => false)).toBe(false)
    } finally {
      await rm(temporary, { force: true, recursive: true })
    }
  }
})

test("official Desktop metadata pins the exact runtime executable and product", () => {
  expect(DESKTOP_ASSET_METADATA["windows-x64"].runtimeExecutable).toEqual({
    name: "OpenCode.exe",
    productVersion: "1.18.21.0",
    sha256: "c96920bb1d1a4dc5cee64d33c404224e3c37c79111007e3aea861b448e2c4999",
  })
  expect(DESKTOP_ASSET_METADATA["linux-x64"].runtimeExecutable).toEqual({
    name: "ai.opencode.desktop",
    productVersion: "1.18.21",
    sha256: "008c5cf72df686019c818d2cb0570df8137b49aa5dae64dcf017ea2656c5b7ac",
  })
})

async function runLinker(input: {
  readonly entry: string
  readonly installedPlugin: string
  readonly resultFile: string
}): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const runtimeExecutableSha256 = createHash("sha256")
    .update(Buffer.from(await Bun.file(process.execPath).arrayBuffer()))
    .digest("hex")
  const sourceFile = join(input.installedPlugin, "linker.mjs")
  await writeFile(sourceFile, desktopRuntimeLinkerSource({
    authoritative: false,
    candidateEntry: input.entry,
    candidateEntrySha256: await digest(input.entry),
    dependencyTreeSha256: "d".repeat(64),
    electronVersion: null,
    installedPlugin: input.installedPlugin,
    nodeVersion: process.versions.node,
    resultFile: input.resultFile,
    runtimeExecutableSha256,
    runtimeProductVersion: "system-node-unit-proof",
  }))
  const child = Bun.spawn([
    process.execPath,
    "--no-warnings",
    "--experimental-vm-modules",
    "--experimental-import-meta-resolve",
    sourceFile,
  ], { stderr: "pipe", stdout: "pipe", windowsHide: true })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr, stdout }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(Buffer.from(await Bun.file(path).arrayBuffer()))
    .digest("hex")
}
