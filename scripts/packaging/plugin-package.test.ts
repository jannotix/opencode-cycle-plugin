import { expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { cleanPluginBuildOutput, validatePluginListing } from "./plugin-package.js"

test("plugin packaging removes stale compiler output before building", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-cycle-plugin-clean-"))
  try {
    const packageRoot = join(root, "packages", "opencode-cycle")
    const output = join(packageRoot, "dist")
    const buildInfo = join(root, "target", "typescript", "opencode-cycle.tsbuildinfo")
    await Promise.all([
      mkdir(output, { recursive: true }),
      mkdir(join(root, "target", "typescript"), { recursive: true }),
    ])
    await writeFile(join(output, "stale.js"), "legacy", "utf8")
    await writeFile(buildInfo, "incremental", "utf8")

    await cleanPluginBuildOutput(packageRoot)

    expect(await readFile(join(output, "stale.js"), "utf8").catch(() => undefined)).toBeUndefined()
    expect(await readFile(buildInfo, "utf8").catch(() => undefined)).toBeUndefined()
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("plugin package rejects compiled modules without a matching source module", () => {
  expect(() =>
    validatePluginListing(
      [
        "package/LICENSE",
        "package/NOTICE",
        "package/dist/index.js",
        "package/dist/stale.js",
        "package/package.json",
      ],
      ["index.js"],
    ),
  ).toThrow("package/dist/stale.js")
})

test("plugin package accepts the exact production module allowlist", () => {
  expect(() =>
    validatePluginListing(
      [
        "package/LICENSE",
        "package/NOTICE",
        "package/dist/browser/session.js",
        "package/dist/index.js",
        "package/package.json",
      ],
      ["browser/session.js", "index.js"],
    ),
  ).not.toThrow()
})

test("public validation sources exist while archives reject non-production paths", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  await Promise.all(
    [
      "tests/workspace.test.ts",
      "crates/workflow-core/examples/export_schema.rs",
      "crates/workflow-code-intel/examples/codebase_500k.rs",
      "docs/security/threat-model.md",
    ].map((path) => access(join(root, path))),
  )

  for (const path of [
    "package/dist/debug/tool.js",
    "package/dist/tests/tool.js",
    "package/dist/example/tool.js",
    "package/dist/fixture/tool.js",
    "package/dist/index.js.map",
    "package/coverage/index.js",
    "package/docs/guide.md",
    "package/.github/workflows/release.yml",
  ]) {
    expect(() => validatePluginListing(["package/LICENSE", "package/NOTICE", "package/package.json", path], [path.slice("package/dist/".length)])).toThrow()
  }
})
