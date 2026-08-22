import { writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import { readReleaseManifest, verifyArtifactDirectory } from "./release-manifest.js"

export async function createChecksumManifest(
  directory: string,
  output: string,
  manifestPath: string,
): Promise<void> {
  const root = resolve(directory)
  const target = resolve(output)
  const manifest = await readReleaseManifest(manifestPath)
  const artifactsDirectory = join(root, "artifacts")
  const artifacts = await verifyArtifactDirectory(artifactsDirectory, manifest.artifacts)
  const lines = artifacts.map((artifact) => {
    const path = join(artifactsDirectory, artifact.name)
    const relativePath = relative(root, path).split(sep).join("/")
    return `${artifact.sha256}  ${relativePath}`
  })
  await writeFile(target, `${lines.join("\n")}\n`, "utf8")
}

async function main(): Promise<void> {
  const values = new Map<string, string>()
  const allowed = new Set(["directory", "manifest", "output"])
  const argumentsList = Bun.argv.slice(2)
  for (let index = 0; index < argumentsList.length; index += 2) {
    const argument = argumentsList[index]
    const value = argumentsList[index + 1]
    if (argument === undefined || value === undefined || !argument.startsWith("--")) {
      throw new Error("Checksum arguments must be --key value pairs")
    }
    const name = argument.slice(2)
    if (!allowed.has(name) || values.has(name)) {
      throw new Error(`Unknown or duplicate argument: ${argument}`)
    }
    values.set(name, value)
  }
  for (const name of allowed) if (!values.has(name)) throw new Error(`Missing --${name}`)
  await createChecksumManifest(
    values.get("directory") as string,
    values.get("output") as string,
    values.get("manifest") as string,
  )
}

if (import.meta.main) await main()
