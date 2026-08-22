import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertSourceUnchanged,
  captureCleanSource,
  type SourceStateProbe,
} from "./source-state.js"

const revision = "a".repeat(40)

test("source receipts reject dirty state before and after the workload", async () => {
  const dirtyBefore: SourceStateProbe = {
    async changes() { return ["?? untracked.txt"] },
    async revision() { return revision },
  }
  await expect(captureCleanSource("C:\\repo", revision, dirtyBefore)).rejects.toThrow("dirty before")

  let calls = 0
  const dirtyAfter: SourceStateProbe = {
    async changes() { return calls++ === 0 ? [] : [" M tracked.txt"] },
    async revision() { return revision },
  }
  const snapshot = await captureCleanSource("C:\\repo", revision, dirtyAfter)
  await expect(assertSourceUnchanged("C:\\repo", snapshot, revision, dirtyAfter)).rejects.toThrow(
    "dirty after",
  )
})

test("source receipts reject claimed or post-workload revision drift", async () => {
  const probe: SourceStateProbe = {
    async changes() { return [] },
    async revision() { return revision },
  }
  await expect(captureCleanSource("C:\\repo", "b".repeat(40), probe)).rejects.toThrow("claimed")
  const snapshot = await captureCleanSource("C:\\repo", revision, probe)
  await expect(
    assertSourceUnchanged("C:\\repo", snapshot, revision, {
      ...probe,
      async revision() { return "c".repeat(40) },
    }),
  ).rejects.toThrow("revision changed")
})

test("ignored designated receipt outputs remain clean while other untracked files fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-source-state-"))
  try {
    await run(["git", "init"], root)
    await run(["git", "config", "user.email", "source-state@example.invalid"], root)
    await run(["git", "config", "user.name", "Source State Test"], root)
    await writeFile(join(root, ".gitignore"), "target/\ncandidate/\n")
    await writeFile(join(root, "tracked.txt"), "tracked")
    await run(["git", "add", ".gitignore", "tracked.txt"], root)
    await run(["git", "commit", "-m", "base"], root)
    const head = (await run(["git", "rev-parse", "HEAD"], root)).trim()
    await Promise.all([
      mkdir(join(root, "target", "certification"), { recursive: true }),
      mkdir(join(root, "candidate", "certification"), { recursive: true }),
    ])
    await writeFile(join(root, "target", "certification", "receipt.json"), "{}")
    await writeFile(join(root, "candidate", "certification", "receipt.json"), "{}")
    await expect(captureCleanSource(root, head)).resolves.toEqual({ revision: head })
    await writeFile(join(root, "untracked.txt"), "not ignored")
    await expect(captureCleanSource(root, head)).rejects.toThrow("untracked.txt")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

async function run(command: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`)
  return stdout
}
