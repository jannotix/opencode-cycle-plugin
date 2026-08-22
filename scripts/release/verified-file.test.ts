import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertStableOpenFile, readVerifiedFileDirectory } from "./verified-file.js"

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
