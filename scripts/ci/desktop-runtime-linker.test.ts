import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"

import { DESKTOP_ASSET_METADATA } from "../release/release-manifest.js"
import { openDesktopDependencyTreeVerification } from "./desktop-dependency-tree.js"
import { bundledDesktopRuntimeLinker } from "./desktop-runtime-linker.js"

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
      fullTreeFileCount: 4,
      unsafeDynamicImportsRejected: true,
      graphFileCount: 3,
      linkedEsmModuleCount: 3,
      runtimeInputFileCount: 4,
      verifiedAssetFileCount: 0,
      verifiedCommonJsModuleCount: 0,
      verifiedJsonModuleCount: 0,
      type: "opencode-cycle-desktop-module-link",
    })
    expect(result.graphSha256).toMatch(/^[0-9a-f]{64}$/u)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

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
}, { timeout: 30_000 })

test("minimal runtime input rejects a missing manifest-exported asset", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-link-missing-asset-"))
  try {
    const installedPlugin = join(temporary, "opencode-cycle")
    const entry = join(installedPlugin, "dist", "index.js")
    const assetPackage = join(installedPlugin, "node_modules", "native-fixture")
    const resultFile = join(temporary, "result.json")
    await Promise.all([
      mkdir(join(installedPlugin, "dist"), { recursive: true }),
      mkdir(assetPackage, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(installedPlugin, "package.json"), `${JSON.stringify({
        dependencies: { "native-fixture": "1.0.0" },
        exports: { ".": "./dist/index.js" },
        type: "module",
      })}\n`),
      writeFile(entry, "const native = import.meta.resolve('native-fixture'); export default native\n"),
      writeFile(join(assetPackage, "package.json"), `${JSON.stringify({
        exports: "./bin/native.exe",
        name: "native-fixture",
        version: "1.0.0",
      })}\n`),
    ])
    const execution = await runLinker({ entry, installedPlugin, resultFile })
    expect(execution.exitCode).not.toBe(0)
    expect(await readFile(resultFile).then(() => true, () => false)).toBe(false)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("trusted module linker parses JavaScript instead of treating loader text in strings as code", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-link-ast-decoy-"))
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
      writeFile(entry, [
        "const decoy = 'require(variable) and import(variable)'",
        "// require(variable)",
        "export default decoy",
      ].join("\n")),
    ])
    const execution = await runLinker({ entry, installedPlugin, resultFile })
    expect(execution).toEqual({ exitCode: 0, stderr: "", stdout: "" })
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("trusted module linker rejects require aliases and generated evaluation loaders", async () => {
  for (const [label, source] of [
    ["require-alias", "const load = require; export default load\n"],
    ["resolve-alias", "const load = import.meta.resolve; export default load\n"],
    ["eval-loader", "const load = eval('require'); export default load\n"],
    ["function-loader", "const load = Function('return require')(); export default load\n"],
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
}, { timeout: 30_000 })

test("trusted module linker rejects computed, reflected and passed loader capabilities", async () => {
  for (const [label, source] of [
    ["reviewer-create-require", [
      'const load = process.getBuiltinModule("node:module")["createRequire"](import.meta.url)',
      'load("./unverified.js")',
      "export default load",
    ].join("\n")],
    ["aliased-get-builtin-module", [
      'const builtin = process["getBuiltin" + "Module"]',
      'const load = builtin("node:module")["create" + "Require"](import.meta.url)',
      'load("./unverified.js")',
      "export default load",
    ].join("\n")],
    ["destructured-get-builtin-module", [
      "const { getBuiltinModule: builtin } = process",
      'const load = builtin("node:module")["createRequire"](import.meta.url)',
      'load("./unverified.js")',
      "export default load",
    ].join("\n")],
    ["reflected-create-require", [
      'const make = Reflect.get(process.getBuiltinModule("node:module"), "createRequire")',
      "const load = make(import.meta.url)",
      'load("./unverified.js")',
      "export default load",
    ].join("\n")],
    ["computed-eval", [
      'const execute = globalThis["ev" + "al"]',
      'execute("require(\\"./unverified.js\\")")',
      "export default execute",
    ].join("\n")],
    ["computed-function", [
      'const Constructor = globalThis["Fun" + "ction"]',
      'const load = Constructor("return process.getBuiltinModule(\\"node:module\\")[\\"createRequire\\"](import.meta.url)")()',
      'load("./unverified.js")',
      "export default load",
    ].join("\n")],
    ["proxied-process", [
      "const facade = new Proxy(process, {})",
      'const load = facade["getBuiltinModule"]("node:module")["createRequire"](import.meta.url)',
      'load("./unverified.js")',
      "export default load",
    ].join("\n")],
    ["passed-get-builtin-module", [
      "const pass = (value) => value",
      'const load = pass(process.getBuiltinModule)("node:module")["createRequire"](import.meta.url)',
      'load("./unverified.js")',
      "export default load",
    ].join("\n")],
    ["destructured-computed-eval", [
      'const { ["ev" + "al"]: execute } = globalThis',
      'execute("require(\\"./unverified.js\\")")',
      "export default execute",
    ].join("\n")],
  ] as const) {
    const temporary = await mkdtemp(join(tmpdir(), `cycle-link-capability-${label}-`))
    try {
      const installedPlugin = join(temporary, "opencode-cycle")
      const entry = join(installedPlugin, "dist", "index.js")
      const resultFile = join(temporary, "result.json")
      await mkdir(join(installedPlugin, "dist"), { recursive: true })
      await Promise.all([
        writeFile(join(installedPlugin, "package.json"), `${JSON.stringify({
          exports: { ".": "./dist/index.js" }, type: "module",
        })}\n`),
        writeFile(entry, source),
      ])
      const execution = await runLinker({ entry, installedPlugin, resultFile })
      expect(execution.exitCode, label).not.toBe(0)
      expect(await readFile(resultFile).then(() => true, () => false), label).toBe(false)
    } finally {
      await rm(temporary, { force: true, recursive: true })
    }
  }
}, { timeout: 60_000 })

test("trusted module linker recursively links ESM reached only through CommonJS", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-link-cjs-esm-"))
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
      writeFile(entry, "import value from './bridge.cjs'; export default value\n"),
      writeFile(join(installedPlugin, "dist", "bridge.cjs"), "module.exports = require('./nested.mjs')\n"),
      writeFile(join(installedPlugin, "dist", "nested.mjs"), "import './missing.mjs'; export default true\n"),
    ])
    const execution = await runLinker({ entry, installedPlugin, resultFile })
    expect(execution.exitCode).not.toBe(0)
    expect(await readFile(resultFile).then(() => true, () => false)).toBe(false)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("trusted module linker links an ESM wrapper over a verified CommonJS bundle", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-link-cjs-wrapper-"))
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
      writeFile(entry, "import { Runtime } from './wrapper.js'; export default Runtime\n"),
      writeFile(join(installedPlugin, "dist", "wrapper.js"), [
        "import runtime from './runtime.cjs'",
        "export const { Runtime } = runtime",
      ].join("\n")),
      writeFile(join(installedPlugin, "dist", "runtime.cjs"), [
        "const crypto = require('node:crypto')",
        "module.exports = { Runtime: class Runtime {}, crypto }",
      ].join("\n")),
    ])
    const execution = await runLinker({ entry, installedPlugin, resultFile })
    expect(execution).toEqual({ exitCode: 0, stderr: "", stdout: "" })
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toMatchObject({
      graphFileCount: 3,
      linkedEsmModuleCount: 2,
      verifiedCommonJsModuleCount: 1,
    })
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("optional peer suppression remains owned by the external package reached from CommonJS", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-link-external-optional-peer-"))
  try {
    const installedPlugin = join(temporary, "opencode-cycle")
    const packageRoot = join(installedPlugin, "node_modules", "@fixture", "browsers")
    const entry = join(installedPlugin, "dist", "index.js")
    const resultFile = join(temporary, "result.json")
    await Promise.all([
      mkdir(join(installedPlugin, "dist"), { recursive: true }),
      mkdir(join(packageRoot, "lib"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(installedPlugin, "package.json"), `${JSON.stringify({
        dependencies: { "@fixture/browsers": "1.0.0" },
        exports: { ".": "./dist/index.js" },
        optionalDependencies: {
          "@opencode-cycle/native-linux-x64": "1.0.0",
          "@opencode-cycle/native-win32-x64": "1.0.0",
        },
        type: "module",
      })}\n`),
      writeFile(entry, "import value from './wrapper.js'; export default value\n"),
      writeFile(join(installedPlugin, "dist", "wrapper.js"), [
        "import runtime from './runtime.cjs'",
        "export default runtime",
      ].join("\n")),
      writeFile(join(installedPlugin, "dist", "runtime.cjs"),
        "module.exports = require('@fixture/browsers/lib/launch.js')\n"),
      writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
        name: "@fixture/browsers",
        peerDependencies: { "proxy-agent": ">=8.0.1" },
        peerDependenciesMeta: { "proxy-agent": { optional: true } },
        type: "module",
        version: "1.0.0",
      })}\n`),
      writeFile(join(packageRoot, "lib", "launch.js"), [
        "export async function proxyAgent() {",
        "  return import('proxy-agent')",
        "}",
      ].join("\n")),
    ])
    const execution = await runLinker({ entry, installedPlugin, resultFile })
    expect(execution).toEqual({ exitCode: 0, stderr: "", stdout: "" })
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toMatchObject({
      linkedEsmModuleCount: 3,
      suppressedOptionalRootCount: 1,
      verifiedCommonJsModuleCount: 1,
    })
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}, { timeout: 30_000 })

test("optional suppression accepts only an exact absent declared root", async () => {
  for (const [label, specifier, installBrokenRoot, shouldPass] of [
    ["absent-root", "optional-loader", false, true],
    ["absent-subpath", "optional-loader/subpath", false, false],
    ["installed-broken-root", "optional-loader", true, false],
  ] as const) {
    const temporary = await mkdtemp(join(tmpdir(), `cycle-link-${label}-`))
    try {
      const installedPlugin = join(temporary, "opencode-cycle")
      const entry = join(installedPlugin, "dist", "index.js")
      const resultFile = join(temporary, "result.json")
      await mkdir(join(installedPlugin, "dist"), { recursive: true })
      if (installBrokenRoot) {
        await mkdir(join(installedPlugin, "node_modules", "optional-loader"), { recursive: true })
        await writeFile(join(installedPlugin, "node_modules", "optional-loader", "package.json"), `${JSON.stringify({
          exports: { ".": "./missing.js" },
          name: "optional-loader",
          version: "1.0.0",
        })}\n`)
      }
      await Promise.all([
        writeFile(join(installedPlugin, "package.json"), `${JSON.stringify({
          exports: { ".": "./dist/index.js" },
          optionalDependencies: { "optional-loader": "1.0.0" },
          type: "module",
        })}\n`),
        writeFile(entry, "import value from './bridge.cjs'; export default value\n"),
        writeFile(join(installedPlugin, "dist", "bridge.cjs"), `module.exports = require(${JSON.stringify(specifier)})\n`),
      ])
      const execution = await runLinker({ entry, installedPlugin, resultFile })
      expect(execution.exitCode === 0).toBe(shouldPass)
    } finally {
      await rm(temporary, { force: true, recursive: true })
    }
  }
}, { timeout: 30_000 })

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
  const sourceFile = join(input.installedPlugin, "..", `linker-${crypto.randomUUID()}.mjs`)
  const verification = await openDesktopDependencyTreeVerification(input.installedPlugin)
  let graphInput: Awaited<ReturnType<typeof verification.openLinkerInput>> | undefined
  try {
    graphInput = verification.openLinkerInput()
    await writeFile(sourceFile, await bundledDesktopRuntimeLinker({
      authoritative: false,
      candidateEntry: input.entry,
      candidateEntrySha256: await digest(input.entry),
      dependencyTreeSha256: verification.receipt.dependencyTreeSha256,
      electronVersion: null,
      fullTreeFileCount: graphInput.fullTreeFileCount,
      installedPlugin: input.installedPlugin,
      nodeVersion: process.versions.node,
      resultFile: input.resultFile,
      runtimeInputContentBytes: graphInput.runtimeInputContentBytes,
      runtimeInputFileCount: graphInput.runtimeInputFileCount,
      runtimeInputSerializedBytes: graphInput.runtimeInputSerializedBytes,
      runtimeInputSha256: graphInput.runtimeInputSha256,
      runtimeExecutableSha256,
      runtimeProductVersion: "system-node-unit-proof",
      verifiedContentTreeSha256: verification.contentTreeSha256,
    }), { flag: "wx", mode: 0o600 })
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--experimental-vm-modules",
      sourceFile,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const inputTransfer = pipeline(graphInput.createReadStream(), child.stdin!)
    const exited = new Promise<number>((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      exited,
      readNodeText(child.stdout!),
      readNodeText(child.stderr!),
      inputTransfer,
    ]).then(([code, standardOutput, standardError]) =>
      [code, standardOutput, standardError] as const)
    await verification.verifyAndClose()
    return { exitCode, stderr, stdout }
  } finally {
    await graphInput?.close().catch(() => undefined)
    await verification.abort()
    await rm(sourceFile, { force: true })
  }
}

async function readNodeText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const value of stream) chunks.push(Buffer.from(value as Uint8Array))
  return Buffer.concat(chunks).toString("utf8")
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(Buffer.from(await Bun.file(path).arrayBuffer()))
    .digest("hex")
}
