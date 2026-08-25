import { parse } from "acorn"

interface AstNode {
  readonly [key: string]: unknown
  readonly type: string
  readonly end?: unknown
  readonly start?: unknown
}

export function rewriteTrustedBrowserBundleLiteralImports(source: string): string {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "script",
  }) as unknown as AstNode
  const replacements: { readonly end: number; readonly start: number; readonly value: string }[] = []
  const visit = (node: AstNode): void => {
    if (node.type === "ImportExpression") {
      if (typeof node.start !== "number" || typeof node.end !== "number") {
        throw new Error("Trusted browser bundle import range is absent")
      }
      const specifier = literalString(node.source)
      replacements.push({
        end: node.end,
        start: node.start,
        value: `Promise.resolve(require(${JSON.stringify(specifier)}))`,
      })
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (["end", "loc", "range", "start", "type"].includes(key)) continue
      if (Array.isArray(value)) for (const item of value) {
        const child = asNode(item)
        if (child !== undefined) visit(child)
      }
      else {
        const child = asNode(value)
        if (child !== undefined) visit(child)
      }
    }
  }
  visit(ast)
  let rewritten = source
  for (const item of replacements.sort((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, item.start)}${item.value}${rewritten.slice(item.end)}`
  }
  return rewritten
}

export function trustedBrowserBundleModuleSpecifiers(source: string): string[] {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "script",
  }) as unknown as AstNode
  const specifiers = new Set<string>()
  const visit = (node: AstNode, parent?: AstNode, parentKey?: string): void => {
    let skipCallee = false
    if (node.type === "ImportExpression") {
      throw new Error("Trusted browser bundle contains a runtime import")
    }
    if (node.type === "CallExpression") {
      const callee = asNode(node.callee)
      const argumentsList = Array.isArray(node.arguments) ? node.arguments : []
      if (callee?.type === "Identifier" && callee.name === "require") {
        if (argumentsList.length !== 1) throw new Error("Trusted browser bundle require arity is unsafe")
        const specifier = literalString(argumentsList[0])
        if (specifier === "bun" || specifier.startsWith("bun:")) {
          throw new Error("Trusted browser bundle contains a Bun loader")
        }
        specifiers.add(specifier)
        skipCallee = true
      }
    }
    if (node.type === "MemberExpression" && forbiddenLoaderMember(node)) {
      throw new Error("Trusted browser bundle contains a loader member")
    }
    if (node.type === "Identifier" && identifierReference(parent, parentKey)) {
      const name = String(node.name)
      if (["Proxy", "createRequire", "eval", "getBuiltinModule"].includes(name)) {
        throw new Error("Trusted browser bundle contains a loader capability")
      }
      if (name === "require" &&
        !(parent?.type === "CallExpression" && parentKey === "callee")) {
        throw new Error("Trusted browser bundle aliases require")
      }
      if (name === "Reflect" &&
        !(parent?.type === "MemberExpression" && parentKey === "object" &&
          memberName(parent) === "apply")) {
        throw new Error("Trusted browser bundle contains unsafe reflection")
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["end", "loc", "range", "start", "type"].includes(key) ||
        (skipCallee && key === "callee")) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          const child = asNode(item)
          if (child !== undefined) visit(child, node, key)
        }
      } else {
        const child = asNode(value)
        if (child !== undefined) visit(child, node, key)
      }
    }
  }
  visit(ast)
  return [...specifiers].sort()
}

function forbiddenLoaderMember(node: AstNode): boolean {
  const object = asNode(node.object)
  const name = memberName(node)
  const objectName = String(object?.name)
  if (["createRequire", "getBuiltinModule"].includes(String(name))) return true
  if (name === "require" && ["module", "process"].includes(objectName)) return true
  if (name === "_load" && objectName === "module") return true
  if (objectName === "Reflect" && name !== "apply") return true
  if (["global", "globalThis"].includes(objectName) &&
    ["eval", "Function", "Proxy", "Reflect", "process", "require"].includes(String(name))) {
    return true
  }
  return false
}

function identifierReference(parent: AstNode | undefined, parentKey: string | undefined): boolean {
  if (parent === undefined) return true
  if (parent.type === "MemberExpression" && parentKey === "property" &&
    parent.computed !== true) return false
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type) &&
    parentKey === "key" && parent.computed !== true) return false
  if (parent.type === "MetaProperty") return false
  return true
}

function memberName(node: AstNode): string | undefined {
  const property = asNode(node.property)
  if (node.computed !== true) return typeof property?.name === "string" ? property.name : undefined
  return staticString(property)
}

function staticString(node: AstNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticString(asNode(node.left))
    const right = staticString(asNode(node.right))
    return left === undefined || right === undefined ? undefined : `${left}${right}`
  }
  if (node?.type === "TemplateLiteral" && Array.isArray(node.expressions) &&
    node.expressions.length === 0 && Array.isArray(node.quasis)) {
    return node.quasis.map((value) => {
      const quasi = asNode(value)
      const cooked = typeof quasi?.value === "object" && quasi.value !== null
        ? (quasi.value as { readonly cooked?: unknown }).cooked
        : undefined
      return typeof cooked === "string" ? cooked : ""
    }).join("")
  }
  return undefined
}

function literalString(value: unknown): string {
  const node = asNode(value)
  if (node?.type !== "Literal" || typeof node.value !== "string" || node.value.length === 0) {
    throw new Error("Trusted browser bundle contains nonliteral module loading")
  }
  return node.value
}

function asNode(value: unknown): AstNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as { readonly type?: unknown }).type === "string"
    ? value as AstNode
    : undefined
}
