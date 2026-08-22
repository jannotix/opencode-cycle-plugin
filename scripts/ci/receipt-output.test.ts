import { expect, test } from "bun:test"
import { access, link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  prepareReceiptOutput,
  publishReceiptAtomically,
  writeReceiptAtomically,
} from "./receipt-output.js"

test("receipt output accepts only its exact untracked target certification lane", async () => {
  const root = await repository()
  try {
    const expected = join(root, "target", "certification", "critical-suite.json")
    await expect(
      prepareReceiptOutput(root, expected, { basename: "critical-suite.json" }),
    ).resolves.toMatchObject({ path: expected })
    await expect(
      prepareReceiptOutput(root, join(root, "arbitrary.json"), { basename: "critical-suite.json" }),
    ).rejects.toThrow("exact designated")

    const outside = join(root, "outside-receipt.json")
    await writeFile(outside, "linked")
    await link(outside, expected)
    await expect(
      prepareReceiptOutput(root, expected, { basename: "critical-suite.json" }),
    ).rejects.toThrow(/link|reparse/)
    await Promise.all([unlink(expected), unlink(outside)])

    await writeFile(expected, "tracked")
    await run(["git", "add", "-f", "target/certification/critical-suite.json"], root)
    await run(["git", "commit", "-m", "tracked receipt"], root)
    await expect(
      prepareReceiptOutput(root, expected, { basename: "critical-suite.json" }),
    ).rejects.toThrow("tracked")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}, 20_000)

test("receipt is present for the dirty-after-write check and removed when that check fails", async () => {
  const root = await repository()
  try {
    const expected = join(root, "target", "certification", "critical-suite.json")
    const prepared = await prepareReceiptOutput(root, expected, { basename: "critical-suite.json" })
    await expect(
      publishReceiptAtomically(prepared, Buffer.from("{}\n"), async () => {
        expect(await access(expected).then(() => true, () => false)).toBeTrue()
        throw new Error("source is dirty after the receipt write")
      }),
    ).rejects.toThrow("dirty after")
    expect(await access(expected).then(() => true, () => false)).toBeFalse()
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}, 20_000)

test("receipt output rejects linked lanes and publishes one verified atomic file", async () => {
  const root = await repository()
  const outside = await mkdtemp(join(tmpdir(), "cycle-receipt-outside-"))
  try {
    await mkdir(join(root, "target"))
    await symlink(outside, join(root, "target", "certification"), process.platform === "win32" ? "junction" : "dir")
    const linked = join(root, "target", "certification", "critical-suite.json")
    await expect(
      prepareReceiptOutput(root, linked, { basename: "critical-suite.json" }),
    ).rejects.toThrow(/link|reparse|alias/)

    await rm(join(root, "target", "certification"), { force: true, recursive: true })
    const prepared = await prepareReceiptOutput(root, linked, { basename: "critical-suite.json" })
    const verified = await writeReceiptAtomically(prepared, Buffer.from("{\"passed\":true}\n"))
    expect(verified.path).toBe(linked)
    expect(verified.content.toString("utf8")).toBe("{\"passed\":true}\n")
    await expect(writeReceiptAtomically(prepared, Buffer.from("duplicate"))).rejects.toThrow(
      /exists|published/,
    )
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(outside, { force: true, recursive: true }),
    ])
  }
}, 20_000)

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cycle-receipt-output-"))
  await run(["git", "init"], root)
  await run(["git", "config", "user.email", "receipt-output@example.invalid"], root)
  await run(["git", "config", "user.name", "Receipt Output Test"], root)
  await writeFile(join(root, ".gitignore"), "target/\n")
  await writeFile(join(root, "tracked.txt"), "tracked")
  await run(["git", "add", ".gitignore", "tracked.txt"], root)
  await run(["git", "commit", "-m", "base"], root)
  return root
}

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
