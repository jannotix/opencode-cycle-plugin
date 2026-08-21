import OpenCodeCycle, * as pluginModule from "../../../packages/opencode-cycle/dist/index.js"

if (typeof OpenCodeCycle !== "function" || Object.keys(pluginModule).join(",") !== "default") {
  throw new Error("The installed plugin entrypoint is invalid")
}
