import { expect, test } from "bun:test"

import {
  CYCLE_COMMANDS,
  CycleCommandError,
  parseCycleCommand,
  registerCycleCommand,
} from "../src/commands.js"
import { renderCycleHelp } from "../src/help.js"

const examples = [
  "setup",
  "run auto",
  "run quick",
  "run full",
  "status",
  "tasks",
  "evidence",
  "models",
  "permissions --confirm",
  "limits",
  "pause",
  "resume",
  "cancel --confirm",
  "retry",
  "history",
  "history verify",
  "memory search query",
  "memory explain item",
  "memory remove item --confirm",
  "doctor",
  "export --confirm",
  "help",
]

test("every approved command parses", () => {
  for (const example of examples) expect(parseCycleCommand(example).status).toBe("ready")
})

test("empty input selects help and invalid commands fail clearly", () => {
  expect(parseCycleCommand("").definition.syntax).toBe("/cycle help")
  expect(() => parseCycleCommand("unknown")).toThrow(CycleCommandError)
})

test("sensitive commands require explicit confirmation", () => {
  for (const command of ["cancel", "memory remove item", "export"]) {
    expect(parseCycleCommand(command).status).toBe("confirmation-required")
  }
})

test("help lists every public command exactly once", () => {
  const help = renderCycleHelp()
  for (const definition of CYCLE_COMMANDS) {
    const marker = `| \`${definition.syntax}\` |`
    expect(help.split(marker)).toHaveLength(2)
  }
})

test("generated documentation matches runtime help", async () => {
  const reference = await Bun.file(
    new URL("../../../docs/commands/reference.md", import.meta.url),
  ).text()
  expect(reference).toBe(renderCycleHelp())
})

test("native command registration is idempotent and preserves other commands", () => {
  const config = { command: { existing: { template: "unchanged" } } }
  registerCycleCommand(config)
  const once = structuredClone(config)
  registerCycleCommand(config)
  expect(config).toEqual(once)
  expect(config.command.existing).toEqual({ template: "unchanged" })
  expect(config.command.cycle.agent).toBe("Cycle")
  expect(config.command.workflow).toBeUndefined()
  expect(CYCLE_COMMANDS.every((command) => command.syntax.startsWith("/cycle "))).toBe(true)
})
