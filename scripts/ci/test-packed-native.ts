import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { packageNative, type NativeTarget } from "../packaging/native-package.js"

const root = fileURLToPath(new URL("../../", import.meta.url))
const target = `${process.platform}-${process.arch}` as NativeTarget
const executable = process.platform === "win32" ? "workflowd.exe" : "workflowd"
const output = await mkdtemp(join(tmpdir(), "opencode-cycle-native-test-"))
const secondOutput = await mkdtemp(join(tmpdir(), "opencode-cycle-native-test-"))
try {
  const binary = join(root, "target", "release", executable)
  const [first, second] = await Promise.all([
    packageNative(root, target, binary, output),
    packageNative(root, target, binary, secondOutput),
  ])
  if (first.checksum !== second.checksum) {
    throw new Error("Native package is not reproducible from identical inputs")
  }
} finally {
  await Promise.all([
    rm(output, { force: true, recursive: true }),
    rm(secondOutput, { force: true, recursive: true }),
  ])
}
