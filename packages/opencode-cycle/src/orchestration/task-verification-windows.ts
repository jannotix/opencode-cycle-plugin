import { spawn } from "node:child_process"
import { isAbsolute, resolve } from "node:path"
import type { Readable } from "node:stream"

const REQUEST_ENV = "CYCLE_VERIFICATION_JOB_REQUEST"

export interface WindowsVerificationJobHost {
  readonly exited: Promise<number>
  readonly pid: number
  readonly stderr: Readable
  readonly stdout: Readable
  readonly terminate: () => Promise<void>
}

export interface WindowsVerificationJobHostInput {
  readonly args: readonly string[]
  readonly binaryPath: string
  readonly directory: string
  readonly environment: Readonly<Record<string, string>>
  readonly tool: string
}

export function spawnWindowsVerificationJobHost(
  input: WindowsVerificationJobHostInput,
): WindowsVerificationJobHost {
  if (
    !isAbsolute(input.binaryPath) || resolve(input.binaryPath) !== input.binaryPath ||
    !isAbsolute(input.directory) || resolve(input.directory) !== input.directory ||
    input.binaryPath.includes("\0") || input.directory.includes("\0")
  ) throw new Error("Windows verification Job host binding is invalid")
  const request = JSON.stringify({
    args: [...input.args],
    cwd: input.directory,
    environment: input.environment,
    program: input.tool,
  })
  if (Buffer.byteLength(request) > 64 * 1024) {
    throw new Error("Windows verification Job request exceeds its bound")
  }
  const child = spawn(input.binaryPath, ["--verification-job-host"], {
    cwd: input.directory,
    detached: false,
    env: { [REQUEST_ENV]: request },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  if (
    !Number.isSafeInteger(child.pid) || (child.pid as number) < 1 ||
    child.stdin === null || child.stdout === null || child.stderr === null
  ) {
    child.once("error", () => undefined)
    child.kill()
    throw new Error("Windows verification Job host failed to start")
  }
  const exited = new Promise<number>((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolveExit(code ?? 1))
  })
  let termination: Promise<void> | undefined
  const terminate = (): Promise<void> => {
    termination ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolveDelivery, reject) => {
        child.stdin?.end("terminate\n", (error?: Error | null) => {
          if (error === undefined || error === null) resolveDelivery()
          else reject(error)
        })
      })
    })()
    return termination
  }
  return {
    exited,
    pid: child.pid as number,
    stderr: child.stderr,
    stdout: child.stdout,
    terminate,
  }
}
