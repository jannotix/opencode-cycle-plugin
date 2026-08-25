import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DESKTOP_LINKER_INPUT_MAGIC,
  desktopDependencyContentTreeSha256,
  normalizeDesktopDependencyFileIdentity,
  openDesktopDependencyTreeVerification,
  parseDesktopDependencyTreeManifest,
  serializeDesktopDependencyTreeManifest,
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

test("dependency evidence normalizes Linux and Windows identities for strict JSON round trips", () => {
  const linuxIdentity = normalizeDesktopDependencyFileIdentity({
    ctimeNs: 1_787_665_604_123_456_789n,
    dev: 18_446_744_073_709_551_615n,
    ino: 9_223_372_036_854_775_807n,
    mode: 33_188n,
    mtimeNs: 1_787_665_600_987_654_321n,
    nlink: 1n,
    size: 42n,
  })
  const windowsIdentity = normalizeDesktopDependencyFileIdentity({
    ctimeMs: 1_787_665_604_125,
    dev: 0,
    ino: 4_294_967_295,
    mode: 33_206,
    mtimeMs: 1_787_665_600_875,
    nlink: 1,
    size: 84,
  })
  expect(linuxIdentity).toEqual({
    changedNanoseconds: "1787665604123456789",
    device: "18446744073709551615",
    inode: "9223372036854775807",
    linkCount: "1",
    mode: "33188",
    modifiedNanoseconds: "1787665600987654321",
    size: "42",
  })
  expect(windowsIdentity).toEqual({
    changedNanoseconds: "1787665604125000000",
    device: "0",
    inode: "4294967295",
    linkCount: "1",
    mode: "33206",
    modifiedNanoseconds: "1787665600875000000",
    size: "84",
  })
  const files = [
    { identity: windowsIdentity, path: "package.json", sha256: "b".repeat(64) },
    { identity: linuxIdentity, path: "dist/index.js", sha256: "a".repeat(64) },
  ]
  const contentTreeSha256 = desktopDependencyContentTreeSha256(files)
  const bytes = serializeDesktopDependencyTreeManifest({
    contentTreeSha256,
    dependencyTree: {
      dependencyFileCount: 0,
      dependencyPackageCount: 0,
      dependencyTotalBytes: 0,
      dependencyTreeSha256: "c".repeat(64),
      schemaVersion: 1,
    },
    files,
  })
  const parsed = parseDesktopDependencyTreeManifest(bytes)
  expect(parsed.files.map((file) => file.path)).toEqual(["dist/index.js", "package.json"])
  expect(parsed.contentTreeSha256).toBe(contentTreeSha256)
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  expect(desktopDependencyContentTreeSha256(parsed.files)).toBe(contentTreeSha256)
  expect(() => parseDesktopDependencyTreeManifest(Buffer.from(JSON.stringify({
    ...parsed,
    schemaVersion: 1,
  })))).toThrow("schema")
})

test("dependency evidence rejects unsafe numeric truncation and malformed decimal identities", () => {
  expect(() => normalizeDesktopDependencyFileIdentity({
    ctimeNs: 1n,
    dev: Number.MAX_SAFE_INTEGER + 1,
    ino: 1,
    mode: 1,
    mtimeNs: 1n,
    nlink: 1,
    size: 1,
  })).toThrow("unsafe")
  const identity = normalizeDesktopDependencyFileIdentity({
    ctimeNs: 1n,
    dev: 1n,
    ino: 1n,
    mode: 1n,
    mtimeNs: 1n,
    nlink: 1n,
    size: 1n,
  })
  const input = {
    contentTreeSha256: "d".repeat(64),
    dependencyTree: {
      dependencyFileCount: 0,
      dependencyPackageCount: 0,
      dependencyTotalBytes: 0,
      dependencyTreeSha256: "c".repeat(64),
      schemaVersion: 1 as const,
    },
    files: [{ identity: { ...identity, size: "01" }, path: "package.json", sha256: "b".repeat(64) }],
  }
  expect(() => serializeDesktopDependencyTreeManifest(input)).toThrow("malformed")
  expect(() => serializeDesktopDependencyTreeManifest({
    ...input,
    files: [{
      identity: { ...identity, inode: 1n } as never,
      path: "package.json",
      sha256: "b".repeat(64),
    }],
  })).toThrow()
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
