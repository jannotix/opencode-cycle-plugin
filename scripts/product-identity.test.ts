import { expect, test } from "bun:test"

import {
  CERTIFIED_NATIVE_PACKAGE_NAMES,
  COMPATIBLE_NATIVE_PACKAGE_NAMES,
  NATIVE_PACKAGE_NAMES,
  PRODUCT_IDENTITY,
  SHIPPED_NATIVE_PACKAGE_NAMES,
} from "./product-identity.js"

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
    "@opencode-cycle/native-darwin-arm64",
    "@opencode-cycle/native-darwin-x64",
    "@opencode-cycle/native-linux-x64",
    "@opencode-cycle/native-win32-x64",
  ])
  expect(SHIPPED_NATIVE_PACKAGE_NAMES).toEqual(NATIVE_PACKAGE_NAMES)
})

test("only Windows and Linux are certified; macOS ships compatible but untested", () => {
  expect(CERTIFIED_NATIVE_PACKAGE_NAMES).toEqual([
    "@opencode-cycle/native-linux-x64",
    "@opencode-cycle/native-win32-x64",
  ])
  expect(COMPATIBLE_NATIVE_PACKAGE_NAMES).toEqual([
    "@opencode-cycle/native-darwin-arm64",
    "@opencode-cycle/native-darwin-x64",
  ])
  // The two sets must stay disjoint and must together be exactly what ships,
  // so a macOS package can never silently enter the certified set.
  expect(CERTIFIED_NATIVE_PACKAGE_NAMES.some((name) =>
    (COMPATIBLE_NATIVE_PACKAGE_NAMES as readonly string[]).includes(name))).toBeFalse()
  expect([...CERTIFIED_NATIVE_PACKAGE_NAMES, ...COMPATIBLE_NATIVE_PACKAGE_NAMES].sort())
    .toEqual([...NATIVE_PACKAGE_NAMES].sort())
  expect(JSON.stringify(CERTIFIED_NATIVE_PACKAGE_NAMES)).not.toContain("darwin")
})
