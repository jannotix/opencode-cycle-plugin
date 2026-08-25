import { expect, test } from "bun:test"

type PackageJson = {
  cpu?: string[]
  dependencies?: Record<string, string>
  files?: string[]
  optionalDependencies?: Record<string, string>
  name?: string
  os?: string[]
  packageManager?: string
  workspaces?: string[]
  version?: string
}

const readPackage = (path: string) => Bun.file(new URL(path, import.meta.url)).json() as Promise<PackageJson>

test("workspace publishes only OpenCode Cycle identities", async () => {
  const plugin = await Bun.file("packages/opencode-cycle/package.json").json()
  expect(plugin.name).toBe("opencode-cycle")
  expect(plugin.repository).toBe("https://github.com/jannotix/opencode-cycle-plugin")
  expect(Object.keys(plugin.optionalDependencies).sort()).toEqual([
    "@opencode-cycle/native-linux-x64",
    "@opencode-cycle/native-win32-x64",
  ])
  expect(await Bun.file("NOTICE").text()).toContain("Cycle for OpenCode")
})

test("workspace pins the certified toolchain and production allowlist", async () => {
  const [root, plugin] = await Promise.all([
    readPackage("../package.json"),
    readPackage("../packages/opencode-cycle/package.json"),
  ])

  expect(root.packageManager).toBe("bun@1.3.14")
  expect(root.name).toBe("opencode-cycle-workspace")
  expect(root.version).toBe("1.0.0")
  expect(await Bun.file("bun.lock").text()).toContain(
    '"": {\n      "name": "opencode-cycle-workspace",',
  )
  expect(plugin.version).toBe("1.0.0")
  expect(root.workspaces).toEqual([
    "packages/native-linux-x64",
    "packages/native-win32-x64",
    "packages/opencode-cycle",
    "packages/protocol-contracts",
  ])
  expect(plugin.dependencies?.["@opencode-ai/plugin"]).toBe("1.18.21")
  expect(plugin.dependencies?.["@opencode-ai/sdk"]).toBe("1.18.21")
  expect(plugin.dependencies?.["@puppeteer/browsers"]).toBe("3.2.0")
  expect(plugin.dependencies?.["puppeteer-core"]).toBe("25.6.0")
  expect(plugin.files).toEqual([
    "dist/**/*.js",
    "dist/**/*.cjs",
    "dist/**/*.mjs",
    "LICENSE",
    "NOTICE",
  ])
  expect(plugin.optionalDependencies).toEqual({
    "@opencode-cycle/native-linux-x64": "1.0.0",
    "@opencode-cycle/native-win32-x64": "1.0.0",
  })
})

for (const [target, os, cpu] of [
  ["linux-x64", "linux", "x64"],
  ["win32-x64", "win32", "x64"],
] as const) {
  test(`native ${target} package is strictly platform-bound`, async () => {
    const manifest = await readPackage(`../packages/native-${target}/package.json`)
    expect(manifest.version).toBe("1.0.0")
    expect(manifest.os).toEqual([os])
    expect(manifest.cpu).toEqual([cpu])
    expect(manifest.files).toEqual(["bin", "LICENSE", "NOTICE"])
    expect(manifest.dependencies).toBeUndefined()
  })
}
