import { expect, test } from "bun:test"
import { Socket } from "node:net"

import { ControlPlaneError, nativePackageName, resolveDataDirectory } from "../src/client.js"
import { connectIpcSocket } from "../src/ipc-reader.js"

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const result = Buffer.alloc(4 + payload.length)
  result.writeUInt32BE(payload.length)
  payload.copy(result, 4)
  return result
}

test("IPC frames arriving during connect are queued before the first read", async () => {
  const socket = new Socket()
  const challenge = { data: { nonce: "challenge" }, type: "challenge" }
  const acknowledgement = { data: { protocol_version: 1 }, type: "authenticated" }
  Object.defineProperty(socket, "connect", {
    value: () => {
      socket.emit("data", Buffer.concat([frame(challenge), frame(acknowledgement)]))
      socket.emit("connect")
      return socket
    },
  })

  const connection = await connectIpcSocket("unused-test-endpoint", { socketFactory: () => socket })
  try {
    socket.emit("close")
    await expect(connection.reader.read()).resolves.toEqual(challenge)
    await expect(connection.reader.read()).resolves.toEqual(acknowledgement)
  } finally {
    connection.reader.dispose()
    socket.destroy()
  }
})

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
