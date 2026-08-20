import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const allowed = new Set([
  "AFL-2.1",
  "Apache-2.0",
  "BSD-1-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "FSL-1.1-MIT",
  "ISC",
  "MIT",
  "Python-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
])

async function main(): Promise<void> {
  const cargo = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--locked"], {
    cwd: root,
    stderr: "inherit",
  })
  if (cargo.exitCode !== 0) throw new Error("cargo metadata failed")
  const metadata = JSON.parse(cargo.stdout.toString()) as {
    packages: { license: string | null; name: string; version: string }[]
  }
  const rejected = new Set<string>()
  const validate = (identity: string, license: string | null): void => {
    if (license === null || !licenseExpressionAllowed(license)) {
      rejected.add(`${identity} (${license ?? "missing"})`)
    }
  }
  for (const dependency of metadata.packages) {
    validate(`${dependency.name}@${dependency.version}`, dependency.license)
  }

  const glob = new Bun.Glob("node_modules/**/package.json")
  const seen = new Set<string>()
  for await (const path of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
    const manifest = (await Bun.file(resolve(root, path)).json()) as {
      license?: unknown
      name?: unknown
      version?: unknown
    }
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue
    const identity = `${manifest.name}@${manifest.version}`
    if (seen.has(identity)) continue
    seen.add(identity)
    validate(identity, typeof manifest.license === "string" ? manifest.license : null)
  }

  if (rejected.size > 0) {
    throw new Error(`Dependencies without an approved license choice: ${[...rejected].sort().join(", ")}`)
  }
  process.stdout.write(
    `Validated licenses for ${metadata.packages.length} Cargo and ${seen.size} installed JavaScript packages.\n`,
  )
}

export function licenseExpressionAllowed(expression: string): boolean {
  try {
    const tokens = expression.replaceAll("/", " OR ").match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/gu)
    if (tokens === null) return false
    let index = 0
    const parsePrimary = (): boolean => {
      const token = tokens[index]
      if (token === "(") {
        index += 1
        const result = parseOr()
        if (tokens[index] !== ")") throw new Error("missing closing parenthesis")
        index += 1
        return result
      }
      if (token === undefined || token === ")" || token === "AND" || token === "OR") {
        throw new Error("expected license identifier")
      }
      index += 1
      const permitted = allowed.has(token)
      if (tokens[index] !== "WITH") return permitted
      index += 1
      const exception = tokens[index]
      if (exception === undefined) throw new Error("expected license exception")
      index += 1
      return permitted && exception === "LLVM-exception"
    }
    const parseAnd = (): boolean => {
      let result = parsePrimary()
      while (tokens[index] === "AND") {
        index += 1
        result = parsePrimary() && result
      }
      return result
    }
    const parseOr = (): boolean => {
      let result = parseAnd()
      while (tokens[index] === "OR") {
        index += 1
        result = parseAnd() || result
      }
      return result
    }
    const result = parseOr()
    return index === tokens.length && result
  } catch {
    return false
  }
}

if (import.meta.main) await main()
