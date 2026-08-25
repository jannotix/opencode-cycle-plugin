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
      expect(input.fileCount).toBe(4)
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
