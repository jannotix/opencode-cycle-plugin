import { expect, test } from "bun:test"

import { ControlPlaneError, nativePackageName, resolveDataDirectory } from "../src/client.js"

test("resolves certified native data directories", () => {
  expect(resolveDataDirectory("win32", { LOCALAPPDATA: "C:\\Users\\person\\AppData\\Local" })).toBe(
    "C:\\Users\\person\\AppData\\Local\\OpenCode Cycle",
  )
  expect(resolveDataDirectory("linux", { HOME: "/home/person" })).toBe(
    "/home/person/.local/share/opencode-cycle",
  )
  expect(resolveDataDirectory("linux", { XDG_DATA_HOME: "/data" })).toBe(
    "/data/opencode-cycle",
  )
})

test("missing required environment fails before filesystem access", () => {
  expect(() => resolveDataDirectory("win32", {})).toThrow(ControlPlaneError)
  expect(() => resolveDataDirectory("darwin", { HOME: "/Users/person" })).toThrow(ControlPlaneError)
  expect(() => resolveDataDirectory("freebsd", { HOME: "/home/person" })).toThrow(ControlPlaneError)
})

test("selects only certified native packages", () => {
  expect(nativePackageName("win32", "x64")).toBe("@opencode-cycle/native-win32-x64")
  expect(nativePackageName("linux", "x64")).toBe("@opencode-cycle/native-linux-x64")
  expect(() => nativePackageName("darwin", "x64")).toThrow(ControlPlaneError)
  expect(() => nativePackageName("darwin", "arm64")).toThrow(ControlPlaneError)
  expect(() => nativePackageName("linux", "arm64")).toThrow(ControlPlaneError)
  expect(() => nativePackageName("freebsd", "x64")).toThrow(ControlPlaneError)
})
