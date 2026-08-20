import { fileURLToPath } from "node:url"

import { renderCycleHelp } from "../../packages/opencode-cycle/src/help.js"

const path = fileURLToPath(new URL("../../docs/commands/reference.md", import.meta.url))
const content = renderCycleHelp()
if (!(await Bun.file(path).exists()) || (await Bun.file(path).text()) !== content) {
  await Bun.write(path, content)
}
