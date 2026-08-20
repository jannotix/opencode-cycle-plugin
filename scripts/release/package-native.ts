import { fileURLToPath } from "node:url"

import { NATIVE_TARGETS, packageNative, type NativeTarget } from "../packaging/native-package.js"

const values = new Map<string, string>()
const argumentsList = process.argv.slice(2)
for (let index = 0; index < argumentsList.length; index += 2) {
  const key = argumentsList[index]
  const value = argumentsList[index + 1]
  if (key === undefined || value === undefined || !key.startsWith("--")) {
    throw new Error("Expected --target, --binary and --output arguments")
  }
  values.set(key.slice(2), value)
}
const target = values.get("target") as NativeTarget | undefined
const binary = values.get("binary")
const output = values.get("output")
if (target === undefined || !(target in NATIVE_TARGETS) || binary === undefined || output === undefined) {
  throw new Error("Expected a certified --target plus --binary and --output paths")
}
const root = fileURLToPath(new URL("../../", import.meta.url))
const result = await packageNative(root, target, binary, output)
process.stdout.write(`${JSON.stringify(result)}\n`)
