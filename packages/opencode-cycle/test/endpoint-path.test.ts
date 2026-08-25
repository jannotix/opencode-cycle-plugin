import { expect, test } from "bun:test"

import { LocalControlPlane } from "../src/client.js"
import {
  assertControlPlaneUnixSocketPath,
  controlPlaneUnixSocketPathBytes,
  MAX_LINUX_UNIX_SOCKET_PATH_BYTES,
} from "../src/endpoint-path.js"

test("Unix endpoint path validation uses the exact UTF-8 byte boundary", () => {
  const exact = dataDirectoryWithEndpointBytes(MAX_LINUX_UNIX_SOCKET_PATH_BYTES, "a")
  expect(assertControlPlaneUnixSocketPath(exact)).toBe(MAX_LINUX_UNIX_SOCKET_PATH_BYTES)
  expect(() => assertControlPlaneUnixSocketPath(`${exact}a`)).toThrow("endpoint_path")

  const multibyte = dataDirectoryWithEndpointBytes(MAX_LINUX_UNIX_SOCKET_PATH_BYTES - 1, "é")
  expect(controlPlaneUnixSocketPathBytes(multibyte)).toBeLessThanOrEqual(
    MAX_LINUX_UNIX_SOCKET_PATH_BYTES,
  )
  expect(() => assertControlPlaneUnixSocketPath(`${multibyte}é`)).toThrow("endpoint_path")
})

test("LocalControlPlane rejects an overlong Linux endpoint before binary access or spawn", () => {
  const overlong = dataDirectoryWithEndpointBytes(MAX_LINUX_UNIX_SOCKET_PATH_BYTES + 1, "a")
  expect(() => new LocalControlPlane({
    binaryPath: "/unreadable-owner-binary",
    dataDirectory: overlong,
    platform: "linux",
  })).toThrow("endpoint_path")
})

function dataDirectoryWithEndpointBytes(target: number, character: string): string {
  let value = "/d"
  while (controlPlaneUnixSocketPathBytes(`${value}${character}`) <= target) value += character
  if (controlPlaneUnixSocketPathBytes(value) !== target) {
    throw new Error("Endpoint fixture cannot reach the requested byte length exactly")
  }
  return value
}
