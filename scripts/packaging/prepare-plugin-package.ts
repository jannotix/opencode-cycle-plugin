import { fileURLToPath } from "node:url"

const root = new URL("../../", import.meta.url)
const packageRoot = new URL("../../packages/opencode-cycle/", import.meta.url)

for (const name of ["LICENSE", "NOTICE"]) {
  const source = await Bun.file(new URL(name, root)).text()
  await Bun.write(fileURLToPath(new URL(name, packageRoot)), source)
}
