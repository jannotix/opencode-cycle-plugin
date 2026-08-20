import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const generation = Bun.spawn(["bun", "scripts/ci/generate-command-reference.ts"], {
  cwd: root,
  stderr: "inherit",
  stdout: "inherit",
})
if ((await generation.exited) !== 0) throw new Error("Command reference generation failed")

const diff = Bun.spawn(
  ["git", "diff", "--exit-code", "--", "docs/commands/reference.md"],
  { cwd: root, stderr: "inherit", stdout: "inherit" },
)
if ((await diff.exited) !== 0) throw new Error("Generated command reference is stale")
