import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertStableOpenFile,
  createVerifiedFileReaderForTests,
  readVerifiedFileDirectory,
} from "./verified-file.js"

test("verified file directory rejects hard links and linked roots", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cycle-verified-files-"))
  try {
    const hardRoot = join(temporary, "hard-root")
    await mkdir(hardRoot)
    const outside = join(temporary, "outside")
    await writeFile(outside, "same bytes")
    await link(outside, join(hardRoot, "artifact.tgz"))
    await expect(readVerifiedFileDirectory(hardRoot)).rejects.toThrow("hard link")

    const target = join(temporary, "target")
    const alias = join(temporary, "alias")
    await mkdir(target)
    await writeFile(join(target, "artifact.tgz"), "bytes")
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
    await expect(readVerifiedFileDirectory(alias)).rejects.toThrow(/link|junction|alias/)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
})

test("verified file metadata fails closed when the opened file changes", () => {
  const stable = {
    ctimeNs: 1n,
    dev: 1n,
    ino: 2n,
    mtimeNs: 3n,
    nlink: 1n,
    size: 4n,
  }
  expect(() => assertStableOpenFile(stable as never, { ...stable } as never)).not.toThrow()
  for (const changed of [
    { ...stable, ino: 9n },
    { ...stable, size: 9n },
    { ...stable, mtimeNs: 9n },
    { ...stable, ctimeNs: 9n },
    { ...stable, nlink: 2n },
  ]) {
    expect(() => assertStableOpenFile(stable as never, changed as never)).toThrow()
  }
})

test("verified file reader rejects same-size path replacement after handle verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-verified-replacement-"))
  const path = join(root, "artifact.tgz")
  try {
    await writeFile(path, "original")
    const reader = createVerifiedFileReaderForTests({
      async afterHandleClosed(target) {
        await rename(target, join(root, "moved.tgz"))
        await writeFile(target, "replaced")
      },
    })
    await expect(reader.readDirectory(root)).rejects.toThrow(/identity|replaced|path/)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("verified directory rejects a post-read extra member", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-verified-extra-"))
  try {
    await writeFile(join(root, "artifact.tgz"), "artifact")
    const reader = createVerifiedFileReaderForTests({
      async afterFilesRead(directory) {
        await writeFile(join(directory, "late-extra.tgz"), "late")
      },
    })
    await expect(reader.readDirectory(root)).rejects.toThrow(/membership|metadata|changed/)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("verified reader fails closed when Windows reparse detection cannot run", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-verified-reparse-check-"))
  try {
    await writeFile(join(root, "artifact.tgz"), "artifact")
    const reader = createVerifiedFileReaderForTests({
      async assertNoReparse() {
        throw new Error("reparse detection unavailable")
      },
    })
    await expect(reader.readDirectory(root)).rejects.toThrow("reparse detection unavailable")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
