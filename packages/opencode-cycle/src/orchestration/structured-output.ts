export function parseTerminalJson(text: string, role: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) return parse(trimmed, role)
  const receipts = [...trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gu)]
  const receipt = receipts[0]
  if (receipts.length === 0) {
    const candidates = [...trimmed.matchAll(/\{/gu)]
      .map((match) => trimmed.slice(match.index))
      .filter((candidate) => validJson(candidate))
    if (candidates.length === 1) return parse(candidates[0] as string, role)
    throw new Error(`${role} result must be one valid JSON object`)
  }
  if (
    receipts.length !== 1 ||
    receipt === undefined ||
    receipt.index === undefined ||
    receipt.index + receipt[0].length !== trimmed.length
  ) {
    throw new Error(`${role} result must be one valid JSON object`)
  }
  return parse(receipt[1] as string, role)
}

function validJson(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function parse(value: string, role: string): unknown {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new Error(`${role} result must be one valid JSON object`, { cause })
  }
}
