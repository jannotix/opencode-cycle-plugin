import { CYCLE_AGENT_NAME, PRODUCT_NAME } from "./product.js"
import { mergeConfigEntry } from "./config-merge.js"

export interface CommandDefinition {
  readonly automatic: string
  readonly description: string
  readonly path: readonly string[]
  readonly requiresConfirmation: boolean
  readonly syntax: string
}

export const CYCLE_COMMANDS: readonly CommandDefinition[] = [
  command("setup", "Guided configuration and compatibility checks", "First-run initialization"),
  command(
    "run [auto|quick|full]",
    "Arm the next exact request with a routing preference",
    "Explicit implementation intent in Cycle",
  ),
  command("status", "Show the latest workflow state, mode, candidate and repair budget", "Native status updates"),
  command("tasks", "Show durable task identifiers and states", "Scheduler operations"),
  command("evidence", "Show recorded candidate gates without raw command output", "Verification pipeline"),
  command("models [role] [provider/model]", "Inspect assignments or assign a model until restart", "Active-model inheritance"),
  command("permissions", "Inspect the immutable role boundaries and active preset", "Balanced defaults"),
  command("limits", "Inspect adaptive admission and repair limits", "Adaptive defaults"),
  command("pause", "Pause the latest workflow at its next safe boundary", "Resource or compatibility pause"),
  command("resume", "Reconcile state and continue paused work", "Resource recovery"),
  command("cancel", "Cancel authorized work safely", "User interruption", true),
  command("retry", "Retry a classified failure or blocked cycle", "Transient retry policy"),
  command("history", "Query project audit events", "Continuous ledger capture"),
  command("history verify", "Verify the hash chain and signed checkpoints", "Checkpoint validation"),
  command("memory search", "Search reusable project knowledge", "Progressive retrieval"),
  command("memory explain", "Explain memory source and confidence", "Selection diagnostics"),
  command("memory remove", "Remove eligible memory", "Retention policy", true),
  command("doctor", "Run read-only installation and project diagnostics", "Startup health checks"),
  command("export", "Export workflow state, ledger, or evidence", "Never automatic", true),
  command("help", "Show the complete command reference", "First-use guidance"),
]

export interface ParsedCycleCommand {
  readonly arguments: readonly string[]
  readonly definition: CommandDefinition
  readonly status: "ready" | "confirmation-required"
}

export class CycleCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CycleCommandError"
  }
}

function command(
  syntax: string,
  description: string,
  automatic: string,
  requiresConfirmation = false,
): CommandDefinition {
  const path = syntax
    .split(" ")
    .filter((segment) => !segment.startsWith("["))
    .slice(0, 2)
  return {
    automatic,
    description,
    path,
    requiresConfirmation,
    syntax: `/cycle ${syntax}`,
  }
}

function tokens(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean)
}

export function parseCycleCommand(argumentsText: string): ParsedCycleCommand {
  const input = tokens(argumentsText)
  if (input.length === 0) input.push("help")

  const definition = [...CYCLE_COMMANDS]
    .sort((left, right) => right.path.length - left.path.length)
    .find((candidate) => candidate.path.every((part, index) => input[index] === part))
  if (definition === undefined) {
    throw new CycleCommandError(`Unknown Cycle command: ${input[0] ?? ""}`)
  }

  const remaining = input.slice(definition.path.length)
  const confirmation = remaining.indexOf("--confirm")
  if (confirmation >= 0) remaining.splice(confirmation, 1)
  const status = definition.requiresConfirmation && confirmation < 0 ? "confirmation-required" : "ready"
  return { arguments: remaining, definition, status }
}

export function registerCycleCommand(config: unknown): void {
  mergeConfigEntry(config, "command", "cycle", {
    agent: CYCLE_AGENT_NAME,
    description: `Run or control ${PRODUCT_NAME}`,
    template: "Execute the native Cycle for OpenCode command with these arguments: $ARGUMENTS",
  })
}
