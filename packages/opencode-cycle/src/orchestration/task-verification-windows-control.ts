const CONTROL_EXIT_TIMEOUT_MILLIS = 5_000

interface WindowsVerificationJobProcess {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly stdin: {
    end(value: string, callback: (error?: Error | null) => void): unknown
  }
  kill(): boolean
}

export async function terminateWindowsVerificationJobProcess(
  child: WindowsVerificationJobProcess,
  exited: Promise<number>,
  timeoutMillis = CONTROL_EXIT_TIMEOUT_MILLIS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited
    return
  }
  let deliveryError: Error | undefined
  try {
    child.stdin.end("terminate\n", (error?: Error | null) => {
      if (error !== undefined && error !== null) deliveryError = error
    })
  } catch (error) {
    deliveryError = error instanceof Error ? error : new Error(String(error))
  }
  if (await exitsWithin(exited, timeoutMillis)) {
    if (deliveryError !== undefined) throw deliveryError
    return
  }
  if (child.exitCode === null && child.signalCode === null && !child.kill()) {
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error("Windows verification Job host exact-handle termination failed")
    }
  }
  if (!(await exitsWithin(exited, timeoutMillis))) {
    throw new Error("Windows verification Job host survived exact-handle termination")
  }
  if (deliveryError !== undefined) throw deliveryError
}

async function exitsWithin(exited: Promise<number>, timeoutMillis: number): Promise<boolean> {
  return new Promise<boolean>((resolveExit, reject) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMillis)
    void exited.then(() => {
      clearTimeout(timeout)
      resolveExit(true)
    }, (error) => {
      clearTimeout(timeout)
      reject(error as Error)
    })
  })
}
