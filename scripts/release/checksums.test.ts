import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createChecksumManifest } from "./checksums.js"

test("checksum manifest is recursive, sorted and excludes itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-cycle-checksums-"))
  try {
    await mkdir(join(root, "nested"))
    await writeFile(join(root, "z.txt"), "z")
    await writeFile(join(root, "nested", "a.txt"), "a")
    const output = join(root, "SHA256SUMS")

    await createChecksumManifest(root, output)

    const lines = (await Bun.file(output).text()).trim().split("\n")
    expect(lines.map((line) => line.split("  ")[1])).toEqual(["nested/a.txt", "z.txt"])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
