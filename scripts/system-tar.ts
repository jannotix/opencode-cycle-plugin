/**
 * Archive extraction depends on the system bsdtar, not on whatever `tar`
 * happens to be first on PATH. A Git Bash shell puts GNU tar ahead of it, and
 * GNU tar fails on these archives with an error that surfaces far from its
 * cause, so Windows resolves the interpreter by absolute path instead of by
 * lookup. A missing binary then fails naming the path it looked for.
 */
import { join } from "node:path"

export function systemTarExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") return "tar"
  const systemRoot = environment.SystemRoot
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error("Windows archive extraction requires SystemRoot")
  }
  return join(systemRoot, "System32", "tar.exe")
}
