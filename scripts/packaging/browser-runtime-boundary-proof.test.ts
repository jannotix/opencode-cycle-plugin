import { expect, test } from "bun:test"

import {
  rewriteTrustedBrowserBundleLiteralImports,
  trustedBrowserBundleModuleSpecifiers,
} from "./browser-runtime-boundary-proof.js"

test("isolated browser worker admits only direct literal map edges", () => {
  expect(trustedBrowserBundleModuleSpecifiers([
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    "module.exports = { fs, path }",
  ].join("\n"))).toEqual(["node:fs", "node:path"])

  for (const [label, source] of [
    ["nonliteral", "require(name)"],
    ["alias", "const load = require; load('node:fs')"],
    ["builtin-module", "process.getBuiltinModule('node:module')"],
    ["computed-create-require", "value['create' + 'Require']('x')"],
    ["eval", `eval('require("node:fs")')`],
    ["proxy", "new Proxy(process, {})"],
    ["reflection", "Reflect.get(process, 'getBuiltinModule')"],
  ] as const) {
    expect(() => trustedBrowserBundleModuleSpecifiers(source), label).toThrow()
  }
})

test("isolated browser worker rewrites literal imports into its static map", () => {
  const rewritten = rewriteTrustedBrowserBundleLiteralImports([
    "async function load() {",
    '  return import("node:path")',
    "}",
    "module.exports = load",
  ].join("\n"))
  expect(rewritten).toContain('Promise.resolve(require("node:path"))')
  expect(rewritten).not.toMatch(/\bimport\s*\(/u)
  expect(trustedBrowserBundleModuleSpecifiers(rewritten)).toEqual(["node:path"])
  expect(() => rewriteTrustedBrowserBundleLiteralImports(
    "const load = (name) => import(name)",
  )).toThrow("nonliteral")
})
