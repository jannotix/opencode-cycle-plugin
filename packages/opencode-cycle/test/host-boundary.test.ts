import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

// The OpenCode plugin API is the one dependency that changes shape with the
// host's major version. Keeping every reference to it behind these two files
// means a port targets a named boundary instead of a search across the tree.
const BOUNDARY_FILES = ["host.ts", "tool-runtime.ts"]

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith(".ts")) files.push(path)
  }
  return files
}

test("only the declared host boundary may import the OpenCode plugin API", async () => {
  const root = resolve(import.meta.dir, "..", "src")
  const files = await sourceFiles(root)
  expect(files.length).toBeGreaterThan(20)

  const offenders: string[] = []
  for (const file of files) {
    const relativePath = relative(root, file).split("\\").join("/")
    if (BOUNDARY_FILES.includes(relativePath)) continue
    if ((await readFile(file, "utf8")).includes("@opencode-ai/")) offenders.push(relativePath)
  }

  expect(offenders).toEqual([])
})

test("the host boundary states exactly what Cycle needs from the host", async () => {
  const source = await readFile(resolve(import.meta.dir, "..", "src", "host.ts"), "utf8")

  // Each of these is a migration point when the host's plugin API changes, so
  // the boundary must name them rather than let them spread.
  for (const exported of ["HostClient", "HostPart", "HostSessionStatus", "HostPlugin", "HostConfig"]) {
    expect(source, exported).toContain(exported)
  }
})
