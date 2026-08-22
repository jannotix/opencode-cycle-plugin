import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u

export function validateCandidateVersion(value: string, packageVersion: string): void {
  if (!SEMANTIC_VERSION.test(value)) {
    throw new Error("Candidate version must be one semantic version")
  }
  if (value !== packageVersion) {
    throw new Error("Candidate version does not match the package version")
  }
}

async function main(): Promise<void> {
  const argumentsList = Bun.argv.slice(2)
  if (argumentsList.length !== 2 || argumentsList[0] !== "--version" || argumentsList[1] === undefined) {
    throw new Error("Expected --version <semantic-version>")
  }
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const manifest = JSON.parse(
    await readFile(join(root, "packages", "opencode-cycle", "package.json"), "utf8"),
  ) as { version?: unknown }
  if (typeof manifest.version !== "string") throw new Error("Plugin package version is missing")
  validateCandidateVersion(argumentsList[1], manifest.version)
  process.stdout.write(`${resolve(root)} candidate version ${argumentsList[1]} is valid\n`)
}

if (import.meta.main) await main()
