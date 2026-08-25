import { tool, type ToolDefinition } from "../tool-runtime.js"

import { BROWSER_OPERATIONS, type BrowserCommand } from "./browser-manager.js"
import type { WorkflowRole } from "../permissions.js"
import { PRODUCT_NAME } from "../product.js"

export interface BrowserToolHost {
  execute(
    sessionId: string,
    command: BrowserCommand,
    approveExternalOrigin: (origin: string) => Promise<void>,
  ): Promise<unknown>
}

export function cycleBrowserTool(host: BrowserToolHost): ToolDefinition {
  return tool({
    description:
      "Control an isolated managed browser and capture deterministic QA evidence. Use label only to describe the call; target elements with selector, testId, role plus name, or text.",
    args: {
      environmentVariable: tool.schema.string().min(1).max(128).optional(),
      exact: tool.schema.boolean().optional(),
      expectedText: tool.schema.string().min(1).max(16_384).optional(),
      expectedUrl: tool.schema.string().min(1).max(4_096).optional(),
      fullPage: tool.schema.boolean().optional(),
      key: tool.schema.string().min(1).max(128).optional(),
      label: tool.schema.string().min(1).max(1_024).optional(),
      name: tool.schema.string().min(1).max(1_024).optional(),
      operation: tool.schema.enum(BROWSER_OPERATIONS),
      path: tool.schema.string().min(1).max(4_096).optional(),
      role: tool.schema.string().min(1).max(128).optional(),
      selector: tool.schema.string().min(1).max(4_096).optional(),
      testId: tool.schema.string().min(1).max(1_024).optional(),
      text: tool.schema.string().min(1).max(16_384).optional(),
      url: tool.schema.string().min(1).max(4_096).optional(),
      value: tool.schema.string().max(65_536).optional(),
    },
    async execute(args, context) {
      const result = await host.execute(context.sessionID, args, async (origin) => {
        await context.ask({
          always: [],
          metadata: { origin },
          patterns: [origin],
          permission: "opencode-cycle.browser.external-origin",
        })
      })
      return {
        output: JSON.stringify(result, null, 2),
        title: `${PRODUCT_NAME} browser ${args.operation}`,
      }
    },
  })
}

export function assertBrowserCommandRole(
  role: WorkflowRole | undefined,
  command: BrowserCommand,
): void {
  if (!["click", "fill", "press", "upload"].includes(command.operation)) return
  if (role !== "executor") {
    throw new Error("Interactive browser actions require an orchestrator-authorized executor session")
  }
}
