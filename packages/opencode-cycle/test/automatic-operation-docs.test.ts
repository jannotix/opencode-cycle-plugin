import { expect, test } from "bun:test"

import { BROWSER_OPERATIONS } from "../src/browser/browser-manager.js"
import { CYCLE_COMMANDS } from "../src/commands.js"
import { ROLE_CONSULTATION_OPERATIONS } from "../src/orchestration/role-consultation.js"
import { GOAL_OPERATIONS, GOAL_TRANSITIONS } from "../src/cycle-tool.js"
import { CYCLE_AGENT_NAME, ROLE_AGENT_NAMES } from "../src/product.js"

test("automatic operation documentation names every governed runtime operation", async () => {
  const documentation = await Bun.file(
    new URL("../../../docs/commands/automatic-operations.md", import.meta.url),
  ).text()

  for (const operation of [
    ...ROLE_CONSULTATION_OPERATIONS,
    ...GOAL_OPERATIONS,
    ...GOAL_TRANSITIONS,
    ...BROWSER_OPERATIONS,
  ]) {
    expect(documentation).toContain(`\`${operation}\``)
  }
})

test("user manual names every command and governed runtime operation", async () => {
  const manual = await Bun.file(new URL("../../../docs/USER_MANUAL.md", import.meta.url)).text()

  for (const command of CYCLE_COMMANDS) expect(manual).toContain(`\`${command.syntax}\``)
  expect(manual).toContain(`\`${CYCLE_AGENT_NAME}\``)
  for (const role of Object.values(ROLE_AGENT_NAMES)) expect(manual).toContain(role)
  for (const operation of [
    ...ROLE_CONSULTATION_OPERATIONS,
    ...GOAL_OPERATIONS,
    ...GOAL_TRANSITIONS,
    ...BROWSER_OPERATIONS,
  ]) {
    expect(manual).toContain(`\`${operation}\``)
  }
})
