export type JsonRecord = Record<string, unknown>

export class ConfigMergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigMergeError"
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function mergeConfigEntry(
  config: unknown,
  field: string,
  key: string,
  defaults: JsonRecord,
  required: JsonRecord = {},
): void {
  if (!isRecord(config)) throw new ConfigMergeError("OpenCode configuration must be an object")

  const currentField = config[field]
  if (currentField !== undefined && !isRecord(currentField)) {
    throw new ConfigMergeError(`${field} configuration must be an object`)
  }

  const entries = currentField ?? {}
  const currentEntry = entries[key]
  if (currentEntry !== undefined && !isRecord(currentEntry)) {
    throw new ConfigMergeError(`${field}.${key} configuration must be an object`)
  }

  config[field] = {
    ...entries,
    [key]: { ...defaults, ...(currentEntry ?? {}), ...required },
  }
}
