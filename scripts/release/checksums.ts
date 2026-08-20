import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

export async function createChecksumManifest(directory: string, output: string): Promise<void> {
  const root = resolve(directory)
  const target = resolve(output)
  const paths = (await findFiles(root)).filter((path) => path !== target).sort()
  const lines = await Promise.all(
    paths.map(async (path) => {
      const digest = createHash("sha256").update(await readFile(path)).digest("hex")
      return `${digest}  ${relative(root, path).split(sep).join("/")}`
    }),
  )
  await writeFile(target, `${lines.join("\n")}\n`, "utf8")
}

async function findFiles(root: string): Promise<string[]> {
  const output: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift() as string
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile()) output.push(path)
    }
  }
  return output
}

async function main(): Promise<void> {
  const directoryIndex = Bun.argv.indexOf("--directory")
  const outputIndex = Bun.argv.indexOf("--output")
  const directory = Bun.argv[directoryIndex + 1]
  const output = Bun.argv[outputIndex + 1]
  if (directoryIndex < 0 || outputIndex < 0 || directory === undefined || output === undefined) {
    throw new Error("Expected --directory <path> --output <path>")
  }
  await createChecksumManifest(directory, output)
}

if (import.meta.main) await main()
