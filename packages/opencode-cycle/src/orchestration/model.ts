export function parseModel(model: string): { modelID: string; providerID: string } {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) throw new Error("Role model is invalid")
  return { modelID: model.slice(separator + 1), providerID: model.slice(0, separator) }
}

export function withPromptVariant<T extends { readonly body?: object }>(
  input: T,
  variant: string | undefined,
): T {
  if (variant === undefined) return input
  // OpenCode 1.18.x accepts variant although its generated SDK type omits it.
  return { ...input, body: { ...input.body, variant } } as T
}
