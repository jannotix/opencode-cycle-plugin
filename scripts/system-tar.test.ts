import { expect, test } from "bun:test"
import { join } from "node:path"

import { systemTarExecutable } from "./system-tar.js"

test("archive extraction resolves the system tar instead of trusting PATH", () => {
  const resolved = systemTarExecutable({ SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv)
  if (process.platform !== "win32") {
    expect(resolved).toBe("tar")
    return
  }
  // A Git Bash PATH resolves `tar` to GNU tar, which cannot read these
  // archives. An absolute path cannot be shadowed by a PATH entry.
  expect(resolved).toBe(join("C:\\Windows", "System32", "tar.exe"))
  expect(() => systemTarExecutable({} as NodeJS.ProcessEnv)).toThrow("SystemRoot")
})
