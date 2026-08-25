import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"

test("Windows Job control timeout kills the exact live host handle and waits for exit", async () => {
  const module = await import("../src/orchestration/task-verification-windows-control.js") as Record<string, unknown>
  const terminate = module.terminateWindowsVerificationJobProcess
  expect(terminate).toBeFunction()
  if (typeof terminate !== "function") return

  const events = new EventEmitter()
  let exitCode: number | null = null
  let kills = 0
  const exited = new Promise<number>((resolve) => events.once("exit", resolve))
  const child = {
    get exitCode() { return exitCode },
    signalCode: null,
    stdin: {
      end(_value: string, callback: (error?: Error | null) => void) { callback() },
    },
    kill() {
      kills += 1
      exitCode = 1
      events.emit("exit", 1)
      return true
    },
  }
  await (terminate as (child: unknown, exited: Promise<number>, timeout: number) => Promise<void>)(
    child,
    exited,
    5,
  )
  expect(kills).toBe(1)
  expect(await exited).toBe(1)
})
