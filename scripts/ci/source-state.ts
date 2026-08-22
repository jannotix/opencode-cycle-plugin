import { resolve } from "node:path"

const FULL_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

export interface SourceStateProbe {
  changes(root: string): Promise<readonly string[]>
  revision(root: string): Promise<string>
}

export interface CleanSourceSnapshot {
  readonly revision: string
}

const gitProbe: SourceStateProbe = {
  async changes(root) {
    const output = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    return output.split(/\r?\n/u).filter((line) => line.length > 0)
  },
  async revision(root) {
    return (await git(root, ["rev-parse", "HEAD"])).trim()
  },
}

export async function captureCleanSource(
  root: string,
  claimedRevision: string | undefined = process.env.CYCLE_RELEASE_REVISION,
  probe: SourceStateProbe = gitProbe,
): Promise<CleanSourceSnapshot> {
  const directory = resolve(root)
  const revision = await probe.revision(directory)
  validateRevision(revision)
  if (claimedRevision !== undefined) {
    validateRevision(claimedRevision)
    if (claimedRevision !== revision) {
      throw new Error("Receipt producer claimed revision does not match full HEAD")
    }
  }
  const changes = await probe.changes(directory)
  if (changes.length > 0) {
    throw new Error(`Receipt producer source is dirty before the workload: ${changes.join(", ")}`)
  }
  return { revision }
}

export async function assertSourceUnchanged(
  root: string,
  snapshot: CleanSourceSnapshot,
  claimedRevision: string | undefined = process.env.CYCLE_RELEASE_REVISION,
  probe: SourceStateProbe = gitProbe,
): Promise<void> {
  const directory = resolve(root)
  const revision = await probe.revision(directory)
  validateRevision(revision)
  if (revision !== snapshot.revision) {
    throw new Error("Receipt producer source revision changed during the workload")
  }
  if (claimedRevision !== undefined && revision !== claimedRevision) {
    throw new Error("Receipt producer claimed revision does not match full HEAD after the workload")
  }
  const changes = await probe.changes(directory)
  if (changes.length > 0) {
    throw new Error(`Receipt producer source is dirty after the workload: ${changes.join(", ")}`)
  }
}

async function git(root: string, argumentsList: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...argumentsList], {
    cwd: root,
    env: minimalGitEnvironment(process.env),
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Cannot inspect receipt source state: ${stderr.trim()}`)
  return stdout
}

function minimalGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: "1" }
  for (const name of ["ComSpec", "HOME", "HOMEDRIVE", "HOMEPATH", "LANG", "PATH", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE"] as const) {
    if (environment[name] !== undefined) output[name] = environment[name]
  }
  return output
}

function validateRevision(revision: string): void {
  if (!FULL_REVISION.test(revision)) throw new Error("Receipt producer revision must be a full Git object ID")
}
