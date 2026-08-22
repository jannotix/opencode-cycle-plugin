import { resolve } from "node:path"

import { prepareReceiptOutput, publishReceiptAtomically } from "./receipt-output.js"
import { assertSourceUnchanged, captureCleanSource } from "./source-state.js"

interface IterationResult {
  readonly durationMs: number
}

interface CriticalResult {
  readonly architecture: string
  readonly completedIterations: number
  readonly iterations: readonly IterationResult[]
  readonly operatingSystem: string
  readonly passed: boolean
  readonly requestedIterations: number
  readonly revision: string
  readonly schemaVersion: 1
}

const commands: readonly (readonly string[])[] = [
  [
    "bun",
    "test",
    "packages/opencode-cycle/test/full-workflow.test.ts",
    "packages/opencode-cycle/test/arbiter.test.ts",
    "packages/opencode-cycle/test/reviewers.test.ts",
  ],
  ["bun", "test", "./packages/opencode-cycle/test/client.e2e.ts"],
  ["cargo", "test", "-p", "workflow-code-intel", "--test", "project_index"],
  ["cargo", "test", "-p", "workflow-core", "--test", "state_machine", "--test", "receipt"],
  ["cargo", "test", "-p", "workflow-ipc", "--test", "auth", "--test", "transport"],
  ["cargo", "test", "-p", "workflow-ledger", "--test", "chain", "--test", "checkpoints"],
  [
    "cargo",
    "test",
    "-p",
    "workflowd",
    "--test",
    "governance_100",
    "--test",
    "runtime_admission",
    "--test",
    "candidate",
    "--test",
    "lifecycle",
    "--test",
    "repair",
    "--test",
    "verification_runner",
  ],
]

export function buildCriticalResult(
  requestedIterations: number,
  iterations: readonly IterationResult[],
  revision: string,
): CriticalResult {
  if (!Number.isSafeInteger(requestedIterations) || requestedIterations < 1) {
    throw new Error("Critical suite iteration count must be a positive integer")
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) {
    throw new Error("Critical suite revision must be a full Git object ID")
  }
  return {
    architecture: process.arch,
    completedIterations: iterations.length,
    iterations,
    operatingSystem: process.platform,
    passed: iterations.length === requestedIterations,
    requestedIterations,
    revision,
    schemaVersion: 1,
  }
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2))
  const root = resolve(import.meta.dir, "../..")
  const output = await prepareReceiptOutput(root, options.output, { basename: "critical-suite.json" })
  const source = await captureCleanSource(root)
  const results: IterationResult[] = []
  let failure: unknown
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const started = performance.now()
    process.stdout.write(`Critical suite iteration ${iteration}/${options.iterations}\n`)
    try {
      for (const command of commands) {
        const process = Bun.spawn([...command], { cwd: root, stderr: "inherit", stdout: "inherit" })
        if ((await process.exited) !== 0) throw new Error(`${command.join(" ")} failed`)
      }
      results.push({ durationMs: Math.round(performance.now() - started) })
    } catch (error) {
      failure = error
      break
    }
  }
  const result = buildCriticalResult(options.iterations, results, source.revision)
  await publishReceiptAtomically(
    output,
    Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
    () => assertSourceUnchanged(root, source),
  )
  if (!result.passed) {
    throw new Error(
      `Critical suite stopped after ${results.length} complete iterations`,
      failure === undefined ? undefined : { cause: failure },
    )
  }
}

function parseArguments(argumentsList: readonly string[]): { iterations: number; output: string } {
  const iterationsIndex = argumentsList.indexOf("--iterations")
  const outputIndex = argumentsList.indexOf("--output")
  const iterations = Number(argumentsList[iterationsIndex + 1])
  const output = argumentsList[outputIndex + 1]
  if (iterationsIndex < 0 || outputIndex < 0 || output === undefined) {
    throw new Error("Expected --iterations <count> --output <path>")
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("Critical suite iteration count must be a positive integer")
  }
  return { iterations, output }
}

if (import.meta.main) await main()
