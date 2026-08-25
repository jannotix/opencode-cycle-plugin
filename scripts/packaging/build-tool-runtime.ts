import { createHash } from "node:crypto"
import { readFile, realpath, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { analyzeJavaScript } from "../ci/desktop-runtime-linker-runtime.js"

const root = resolve(import.meta.dir, "../..")
const packageRoot = resolve(root, "packages", "opencode-cycle")
const entrypoint = resolve(packageRoot, "src", "tool-runtime.ts")
const output = resolve(packageRoot, "dist", "tool-runtime.js")
const zodRoot = await realpath(resolve(root, "node_modules", ".bun", "node_modules", "zod"))
const patchedFiles = new Map([
  [
    resolve(zodRoot, "v4", "core", "util.js"),
    "d99bf396f177afe547703eff48b9746c360bfc2a2708adfd4a43e73768107b6c",
  ],
  [
    resolve(zodRoot, "v4", "core", "doc.js"),
    "e084bbcc536746a8942fd33b08afe4db345554b3a0383114f1dca95261c958d9",
  ],
])
const observed = new Set<string>()

const build = await Bun.build({
  entrypoints: [entrypoint],
  format: "esm",
  packages: "bundle",
  plugins: [{
    name: "disable-pinned-zod-runtime-code-generation",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]core[\\/](?:doc|util)\.js$/u }, async (input) => {
        const path = await realpath(input.path)
        const expected = patchedFiles.get(path)
        if (expected === undefined) throw new Error("Unexpected Zod code-generation source path")
        const source = await readFile(path, "utf8")
        if (digest(source) !== expected) throw new Error("Pinned Zod code-generation source changed")
        observed.add(path)
        if (path.endsWith("util.js")) {
          const pattern = /export const allowsEval = cached\(\(\) => \{[\s\S]*?\n\}\);/u
          if ((source.match(pattern) ?? []).length !== 1) throw new Error("Pinned Zod eval probe changed")
          const proxyPattern = /export function createTransparentProxy\(getter\) \{[\s\S]*?\n\}\n(?=export function stringifyPrimitive)/u
          if ((source.match(proxyPattern) ?? []).length !== 1) {
            throw new Error("Pinned Zod transparent proxy changed")
          }
          const withoutEval = source.replace(
            pattern,
            "export const allowsEval = cached(() => false);",
          )
          return {
            contents: withoutEval.replace(proxyPattern, [
              "export function createTransparentProxy(_getter) {",
              '    throw new Error("Zod transparent proxies are disabled");',
              "}",
            ].join("\n")),
            loader: "js",
          }
        }
        const pattern = /    compile\(\) \{[\s\S]*?\n    \}\n/u
        if ((source.match(pattern) ?? []).length !== 1) throw new Error("Pinned Zod compiler changed")
        return {
          contents: source.replace(pattern, [
            "    compile() {",
            '        throw new Error("Zod runtime code generation is disabled");',
            "    }",
            "",
          ].join("\n")),
          loader: "js",
        }
      })
    },
  }],
  sourcemap: "none",
  target: "node",
})
if (!build.success || build.outputs.length !== 1) {
  throw new Error(`Tool runtime bundle failed: ${build.logs.map((log) => log.message).join("; ")}`)
}
if (!observed.has(resolve(zodRoot, "v4", "core", "util.js"))) {
  throw new Error("Pinned Zod eval probe was not included in the tool runtime")
}
const bundle = Buffer.from(await build.outputs[0]!.arrayBuffer())
if (bundle.byteLength < 1 || bundle.byteLength > 4 * 1024 * 1024) {
  throw new Error("Tool runtime bundle size is outside its production bound")
}
const source = bundle.toString("utf8")
analyzeJavaScript(source, output, "esm")
if (source.includes("const F = Function") || source.includes("new Function") ||
  source.includes("createRequire") || source.includes("getBuiltinModule")) {
  throw new Error("Tool runtime bundle retains a generated loader capability")
}
await writeFile(output, bundle)

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
