import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const generation = Bun.spawn(["bun", "scripts/ci/generate-contracts.ts"], {
  cwd: root,
  stderr: "inherit",
  stdout: "inherit",
})
if ((await generation.exited) !== 0) throw new Error("Contract generation failed")

const diff = Bun.spawn(
  [
    "git",
    "diff",
    "--exit-code",
    "--",
    "packages/protocol-contracts/schema",
    "packages/protocol-contracts/src/generated.ts",
    "packages/protocol-contracts/src/generated-schema.ts",
  ],
  { cwd: root, stderr: "inherit", stdout: "inherit" },
)
if ((await diff.exited) !== 0) throw new Error("Generated protocol contracts are stale")
