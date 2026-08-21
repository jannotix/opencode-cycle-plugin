import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { assertGitRepository, inspectGitRepository } from "../src/git-repository.js"

const execFileAsync = promisify(execFile)

test("inspectGitRepository reports a Git worktree", async () => {
  const repository = await mkdtemp(join(tmpdir(), "opencode-cycle-git-ok-"))
  try {
    await execFileAsync("git", ["-C", repository, "init"], { windowsHide: true })
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.invalid"], {
      windowsHide: true,
    })
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Test User"], {
      windowsHide: true,
    })
    await writeFile(join(repository, "tracked.txt"), "base\n")
    await execFileAsync("git", ["-C", repository, "add", "tracked.txt"], { windowsHide: true })
    await execFileAsync("git", ["-C", repository, "commit", "--no-verify", "-m", "base"], {
      windowsHide: true,
    })
    await expect(inspectGitRepository(repository)).resolves.toEqual({
      message: "Project directory is a Git repository.",
      repository: true,
    })
    await expect(assertGitRepository(repository)).resolves.toBeUndefined()
  } finally {
    await rm(repository, { force: true, recursive: true })
  }
})

test("assertGitRepository fails closed outside a Git repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-cycle-git-missing-"))
  try {
    const inspection = await inspectGitRepository(directory)
    expect(inspection.repository).toBe(false)
    expect(inspection.message).toContain("requires a Git repository")
    await expect(assertGitRepository(directory)).rejects.toThrow("requires a Git repository")
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
