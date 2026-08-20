import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import {
  ROLE_CONSULTATION_OPERATIONS,
  type RoleConsultationOperation,
} from "./orchestration/role-consultation.js"
import { PRODUCT_NAME } from "./product.js"

export interface RoleConsultationHost {
  invoke(
    sessionId: string,
    operation: RoleConsultationOperation,
    signal: AbortSignal,
  ): Promise<unknown> | unknown
}

export function cycleRoleTool(host: RoleConsultationHost): ToolDefinition {
  return tool({
    description:
      `Consult one isolated ${PRODUCT_NAME} role without starting an implementation workflow. All operations are advisory and read-only.`,
    args: {
      operation: tool.schema.enum(ROLE_CONSULTATION_OPERATIONS),
    },
    async execute(args, context) {
      return {
        output: JSON.stringify(
          await host.invoke(context.sessionID, args.operation, context.abort),
          null,
          2,
        ),
        title: `${PRODUCT_NAME} ${args.operation.replaceAll("_", " ")}`,
      }
    },
  })
}
