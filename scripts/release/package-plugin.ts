import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { packagePlugin } from "../packaging/plugin-package.js"

const root = fileURLToPath(new URL("../../", import.meta.url))
const options = new Map<string, string>()
for (let index = 0; index < Bun.argv.length; index += 1) {
  const argument = Bun.argv[index]
  const value = Bun.argv[index + 1]
  if (argument === "--output" && value !== undefined) options.set("output", value)
}
const output = options.get("output")
if (output === undefined) throw new Error("Expected --output <directory>")
const result = await packagePlugin(root, resolve(output))
process.stdout.write(`${JSON.stringify(result)}\n`)
