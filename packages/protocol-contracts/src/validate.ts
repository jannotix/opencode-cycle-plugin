import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

import type { ProtocolEnvelope } from "./generated.js"
import { protocolSchema } from "./generated-schema.js"

export const PROTOCOL_VERSION = 1

const ajv = new Ajv2020({ allErrors: true })
addFormats(ajv)
const validator = ajv.compile<ProtocolEnvelope>(protocolSchema)

export class ProtocolValidationError extends Error {
  constructor(readonly errors: ErrorObject[] | null | undefined) {
    super("Invalid Cycle for OpenCode protocol envelope")
    this.name = "ProtocolValidationError"
  }
}

export function parseProtocolEnvelope(value: unknown): ProtocolEnvelope {
  if (!validator(value) || value.version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(validator.errors)
  }
  return value
}
