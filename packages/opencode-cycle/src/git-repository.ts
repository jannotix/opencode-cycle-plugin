import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function inspectGitRepository(directory: string): Promise<{
  readonly message: string
  readonly repository: boolean
}> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    })
    if (stdout.trim() === "true") {
      return { message: "Project directory is a Git repository.", repository: true }
    }
  } catch {}
  return {
    message:
      "Cycle for OpenCode requires a Git repository for freeze and delivery. Initialize Git in this project before starting a governed workflow.",
    repository: false,
  }
}

export async function assertGitRepository(directory: string): Promise<void> {
  const inspection = await inspectGitRepository(directory)
  if (!inspection.repository) throw new Error(inspection.message)
}
