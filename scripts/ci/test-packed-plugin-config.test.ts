import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

test("packed production gates build and package the release workflowd binary", async () => {
  const root = resolve(import.meta.dir, "../..")
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>
  }
  const pluginGate = await readFile(resolve(import.meta.dir, "test-packed-plugin.ts"), "utf8")
  const nativeGate = await readFile(resolve(import.meta.dir, "test-packed-native.ts"), "utf8")

  expect(manifest.scripts["test:package"]).toContain("cargo build -p workflowd --release")
  expect(manifest.scripts["test:native-package"]).toContain("cargo build -p workflowd --release")
  expect(pluginGate).toContain('join(root, "target", "release", executable)')
  expect(nativeGate).toContain('join(root, "target", "release", executable)')
})
