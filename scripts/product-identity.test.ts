import { expect, test } from "bun:test"

import { NATIVE_PACKAGE_NAMES, PRODUCT_IDENTITY, SHIPPED_NATIVE_PACKAGE_NAMES } from "./product-identity.js"

test("release identity is exactly Cycle for OpenCode", () => {
  expect(PRODUCT_IDENTITY).toEqual({
    activationMarker: "Cycle for OpenCode activated",
    agent: "Cycle",
    command: "cycle",
    mainPackage: "opencode-cycle",
    product: "Cycle for OpenCode",
    repository: "https://github.com/jannotix/opencode-cycle-plugin",
    service: "opencode-cycle",
    tools: ["cycle_control", "cycle_role", "cycle_browser"],
  })
  expect(NATIVE_PACKAGE_NAMES).toEqual([
    "@opencode-cycle/native-linux-x64",
    "@opencode-cycle/native-win32-x64",
  ])
  expect(SHIPPED_NATIVE_PACKAGE_NAMES).toEqual([
    "@opencode-cycle/native-linux-x64",
    "@opencode-cycle/native-win32-x64",
  ])
})
