import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DESKTOP_LINKER_INPUT_MAGIC,
  openDesktopDependencyTreeVerification,
} from "./desktop-dependency-tree.js"

test("open dependency proof rejects late directory membership additions", async () => {
  const fixture = await dependencyFixture("late-addition")
  const session = await openDesktopDependencyTreeVerification(fixture.installedPlugin)
  try {
    await writeFile(join(fixture.dependency, "late.js"), "export default false\n")
    await expect(session.verifyAndClose()).rejects.toThrow("changed")
  } finally {
    await session.abort()
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("open dependency proof rejects a same-size path replacement", async () => {
  const fixture = await dependencyFixture("replacement")
  const target = join(fixture.dependency, "index.js")
  const replacement = join(fixture.dependency, "replacement.js")
  const session = await openDesktopDependencyTreeVerification(fixture.installedPlugin)
  try {
    await writeFile(replacement, "export default false\n")
    await rename(target, join(fixture.dependency, "original.js"))
    await rename(replacement, target)
    await expect(session.verifyAndClose()).rejects.toThrow("changed")
  } finally {
    await session.abort()
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("open dependency proof fails closed when a verified member is removed", async () => {
  const fixture = await dependencyFixture("removed-member")
  const session = await openDesktopDependencyTreeVerification(fixture.installedPlugin)
  try {
    await rm(join(fixture.dependency, "index.js"))
    await expect(session.verifyAndClose()).rejects.toThrow("changed")
  } finally {
    await session.abort()
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("open dependency proof exposes a linker input built from retained verified bytes", async () => {
  const fixture = await dependencyFixture("held-linker-input")
  const session = await openDesktopDependencyTreeVerification(fixture.installedPlugin)
  try {
    const input = session.openLinkerInput()
    try {
      expect(input.fullTreeFileCount).toBe(4)
      expect(input.runtimeInputFileCount).toBe(4)
      expect(input.runtimeInputContentBytes).toBeGreaterThan(0)
      expect(input.runtimeInputSerializedBytes).toBeGreaterThan(input.runtimeInputContentBytes)
      expect(input.runtimeInputSha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(session.contentManifest).toHaveLength(4)
      expect(session.contentManifest.map((file) => file.path)).toEqual([
        "dist/index.js",
        "node_modules/fixture-dependency/index.js",
        "node_modules/fixture-dependency/package.json",
        "package.json",
      ])
      expect(input.contentTreeSha256).toMatch(/^[0-9a-f]{64}$/u)
      const chunks: Buffer[] = []
      for await (const chunk of input.createReadStream()) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks).subarray(0, DESKTOP_LINKER_INPUT_MAGIC.length).toString())
        .toBe(DESKTOP_LINKER_INPUT_MAGIC)
    } finally {
      await input.close()
    }
  } finally {
    await session.abort()
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("linker input keeps held bytes even when the verified path is replaced", async () => {
  const fixture = await dependencyFixture("held-bytes-not-reopened")
  const target = join(fixture.dependency, "index.js")
  await writeFile(target, "export default 'held-original-token'\n")
  const session = await openDesktopDependencyTreeVerification(fixture.installedPlugin)
  const input = session.openLinkerInput()
  try {
    await writeFile(target, "export default 'path-replacement-token'\n")
    const chunks: Buffer[] = []
    for await (const chunk of input.createReadStream()) chunks.push(Buffer.from(chunk))
    const framedBytes = Buffer.concat(chunks).toString("utf8")
    expect(framedBytes).toContain("held-original-token")
    expect(framedBytes).not.toContain("path-replacement-token")
    await expect(session.verifyAndClose()).rejects.toThrow("changed")
  } finally {
    await input.close()
    await session.abort()
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("runtime input keeps source and exported asset metadata but excludes unrelated held bytes", async () => {
  const fixture = await dependencyFixture("minimal-runtime-input")
  const binary = join(fixture.dependency, "bin", "workflowd.exe")
  await mkdir(join(fixture.dependency, "bin"), { recursive: true })
  await Promise.all([
    writeFile(join(fixture.dependency, "package.json"), `${JSON.stringify({
      exports: "./bin/workflowd.exe",
      name: "fixture-dependency",
      version: "1.0.0",
    })}\n`),
    writeFile(binary, Buffer.alloc(64 * 1024, 0x5a)),
    writeFile(join(fixture.dependency, "LICENSE"), "unrelated-license-token\n".repeat(512)),
    writeFile(join(fixture.dependency, "README.md"), "unrelated-documentation-token\n".repeat(512)),
    writeFile(join(fixture.dependency, "index.js.map"), "unrelated-source-map-token\n".repeat(512)),
    writeFile(join(fixture.installedPlugin, "dist", "index.js"),
      "const model = import.meta.resolve('./model.wasm'); export default model\n"),
    writeFile(join(fixture.installedPlugin, "dist", "model.wasm"), Buffer.alloc(2048, 0x4d)),
  ])
  const session = await openDesktopDependencyTreeVerification(fixture.installedPlugin)
  const input = session.openLinkerInput()
  try {
    expect(input.fullTreeFileCount).toBe(9)
    expect(input.runtimeInputFileCount).toBe(6)
    expect(input.runtimeInputSerializedBytes).toBeLessThan(input.fullTreeSerializedBytes)
    const chunks: Buffer[] = []
    for await (const chunk of input.createReadStream()) chunks.push(Buffer.from(chunk))
    const framed = Buffer.concat(chunks)
    expect(framed.byteLength).toBe(input.runtimeInputSerializedBytes)
    expect(framed.toString("utf8")).toContain("bin/workflowd.exe")
    expect(framed.toString("utf8")).toContain("dist/model.wasm")
    expect(framed.includes(Buffer.alloc(1024, 0x5a))).toBe(false)
    expect(framed.includes(Buffer.alloc(1024, 0x4d))).toBe(false)
    expect(framed.toString("utf8")).not.toContain("unrelated-license-token")
    expect(framed.toString("utf8")).not.toContain("unrelated-documentation-token")
    expect(framed.toString("utf8")).not.toContain("unrelated-source-map-token")
  } finally {
    await input.close()
    await session.abort()
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

test("runtime input fails before serialization when a required package manifest is missing", async () => {
  const fixture = await dependencyFixture("missing-required-manifest")
  await rm(join(fixture.dependency, "package.json"))
  try {
    await expect(openDesktopDependencyTreeVerification(fixture.installedPlugin))
      .rejects.toThrow("contained")
  } finally {
    await rm(fixture.temporary, { force: true, recursive: true })
  }
})

async function dependencyFixture(label: string): Promise<{
  readonly dependency: string
  readonly installedPlugin: string
  readonly temporary: string
}> {
  const temporary = await mkdtemp(join(tmpdir(), `cycle-tree-${label}-`))
  const installedPlugin = join(temporary, "opencode-cycle")
  const dependency = join(installedPlugin, "node_modules", "fixture-dependency")
  await Promise.all([
    mkdir(join(installedPlugin, "dist"), { recursive: true }),
    mkdir(dependency, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(installedPlugin, "package.json"), `${JSON.stringify({
      dependencies: { "fixture-dependency": "1.0.0" },
      exports: { ".": "./dist/index.js" },
      type: "module",
    })}\n`),
    writeFile(join(installedPlugin, "dist", "index.js"), "export default true\n"),
    writeFile(join(dependency, "package.json"), `${JSON.stringify({
      name: "fixture-dependency",
      version: "1.0.0",
    })}\n`),
    writeFile(join(dependency, "index.js"), "export default true\n"),
  ])
  return { dependency, installedPlugin, temporary }
}
