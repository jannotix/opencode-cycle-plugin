import { expect, test } from "bun:test"
import { Socket } from "node:net"

import { ControlPlaneError, nativePackageName, resolveDataDirectory } from "../src/client.js"
import {
  connectIpcSocket,
  IpcFrameReader,
  MAX_IPC_FRAME_BYTES,
  MAX_QUEUED_IPC_BYTES,
  MAX_QUEUED_IPC_FRAMES,
  type IpcReaderLimits,
} from "../src/ipc-reader.js"

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const result = Buffer.alloc(4 + payload.length)
  result.writeUInt32BE(payload.length)
  payload.copy(result, 4)
  return result
}

function readerWithLimits(socket: Socket, limits: IpcReaderLimits): IpcFrameReader {
  return new IpcFrameReader(socket, (message) => new Error(message), limits)
}

function phase(
  reader: IpcFrameReader,
  value: unknown,
  timeoutMillis?: number,
): Promise<unknown> {
  return reader.writeAndRead(frame(value), timeoutMillis)
}

function installSynchronousWrite(
  socket: Socket,
  onWrite: (chunk: Buffer) => void,
): void {
  Object.defineProperty(socket, "write", {
    configurable: true,
    value: (chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean => {
      onWrite(Buffer.from(chunk))
      callback?.()
      return true
    },
  })
}

function expectReaderListenersDetached(socket: Socket): void {
  expect(socket.listenerCount("data")).toBe(0)
  expect(socket.listenerCount("error")).toBe(0)
  expect(socket.listenerCount("close")).toBe(0)
}

test("a challenge arriving synchronously before connect is queued for authentication", async () => {
  const socket = new Socket()
  const challenge = { data: { nonce: "challenge" }, type: "challenge" }
  Object.defineProperty(socket, "connect", {
    value: () => {
      socket.emit("data", frame(challenge))
      socket.emit("connect")
      return socket
    },
  })

  const connection = await connectIpcSocket("unused-test-endpoint", { socketFactory: () => socket })
  try {
    await expect(connection.reader.read()).resolves.toEqual(challenge)
  } finally {
    connection.reader.dispose()
    socket.destroy()
  }
})

test("default queue caps cover only the one-use three-frame protocol", () => {
  expect(MAX_QUEUED_IPC_FRAMES).toBe(3)
  expect(MAX_QUEUED_IPC_BYTES).toBe(3 * (MAX_IPC_FRAME_BYTES + 4))
})

test("an authentication acknowledgement queued before authenticate is rejected without writing", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const challenge = { data: { nonce: "challenge" }, type: "challenge" }
  const acknowledgement = { data: { protocol_version: 1 }, type: "authenticated" }
  let writes = 0
  installSynchronousWrite(socket, () => {
    writes += 1
  })

  socket.emit("data", Buffer.concat([frame(challenge), frame(acknowledgement)]))
  await expect(reader.read()).resolves.toEqual(challenge)
  await expect(phase(reader, { type: "authenticate" })).rejects.toThrow(
    "workflowd sent an IPC frame before the client initiated the protocol phase",
  )
  expect(writes).toBe(0)
  expectReaderListenersDetached(socket)
  socket.destroy()
})

test("a response queued before its request is rejected without a second write", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const acknowledgement = { data: { protocol_version: 1 }, type: "authenticated" }
  const prematureResponse = { data: { request_id: 1 }, type: "health" }
  let writes = 0
  installSynchronousWrite(socket, () => {
    writes += 1
    socket.emit("data", frame(acknowledgement))
  })

  await expect(phase(reader, { type: "authenticate" })).resolves.toEqual(acknowledgement)
  socket.emit("data", frame(prematureResponse))
  await expect(phase(reader, { type: "health" })).rejects.toThrow(
    "workflowd sent an IPC frame before the client initiated the protocol phase",
  )
  expect(writes).toBe(1)
  expectReaderListenersDetached(socket)
  socket.destroy()
})

test("a phase read is armed before a synchronous response to its write", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const response = { data: { request_id: 1 }, type: "health" }
  installSynchronousWrite(socket, () => {
    socket.emit("data", frame(response))
  })

  try {
    await expect(phase(reader, { data: { request_id: 1 }, type: "health" })).resolves.toEqual(
      response,
    )
  } finally {
    reader.dispose()
    socket.destroy()
  }
})

test("fragmented and coalesced frames remain ordered", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const first = { data: { request_id: 1 }, type: "first" }
  const second = { data: { request_id: 2 }, type: "second" }
  const firstFrame = frame(first)
  const pending = reader.read()

  socket.emit("data", firstFrame.subarray(0, 2))
  socket.emit("data", Buffer.concat([firstFrame.subarray(2), frame(second)]))

  try {
    await expect(pending).resolves.toEqual(first)
    await expect(reader.read()).resolves.toEqual(second)
  } finally {
    reader.dispose()
    socket.destroy()
  }
})

test("queued frame count overflow is terminal and detaches listeners", async () => {
  const socket = new Socket()
  const reader = readerWithLimits(socket, { maxQueuedBytes: 1_024, maxQueuedFrames: 3 })
  socket.emit(
    "data",
    Buffer.concat([frame({ id: 1 }), frame({ id: 2 }), frame({ id: 3 }), frame({ id: 4 })]),
  )

  await expect(reader.read()).rejects.toThrow("workflowd exceeded the queued IPC frame limit")
  await expect(reader.read()).rejects.toThrow("workflowd exceeded the queued IPC frame limit")
  expectReaderListenersDetached(socket)
  socket.destroy()
})

test("queued encoded-byte overflow is terminal and detaches listeners", async () => {
  const socket = new Socket()
  const first = frame({ value: "first" })
  const second = frame({ value: "second" })
  const reader = readerWithLimits(socket, {
    maxQueuedBytes: first.length + second.length - 1,
    maxQueuedFrames: 3,
  })
  socket.emit("data", Buffer.concat([first, second]))

  await expect(reader.read()).rejects.toThrow("workflowd exceeded the queued IPC byte limit")
  await expect(reader.read()).rejects.toThrow("workflowd exceeded the queued IPC byte limit")
  expectReaderListenersDetached(socket)
  socket.destroy()
})

test("a read timeout is terminal and ignores late frames", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const timeout = await reader.read(0).catch((error: unknown) => error)

  expect(timeout).toBeInstanceOf(Error)
  expect((timeout as Error).message).toBe("workflowd response timed out")
  expectReaderListenersDetached(socket)
  socket.emit("data", frame({ type: "late" }))
  const future = await reader.read().catch((error: unknown) => error)
  expect(future).toBe(timeout)
  socket.destroy()
})

test("a malformed frame is terminal and detaches listeners", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const pending = reader.read()
  const invalid = Buffer.alloc(4)
  invalid.writeUInt32BE(0)
  socket.emit("data", invalid)

  const malformed = await pending.catch((error: unknown) => error)
  expect(malformed).toBeInstanceOf(Error)
  expect((malformed as Error).message).toBe("workflowd sent an invalid IPC frame size")
  expect(await reader.read().catch((error: unknown) => error)).toBe(malformed)
  expectReaderListenersDetached(socket)
  socket.destroy()
})

test("socket close discards queued frames and rejects future reads", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  socket.emit("data", frame({ type: "queued" }))
  socket.emit("close")

  await expect(reader.read()).rejects.toThrow("workflowd disconnected before responding")
  expectReaderListenersDetached(socket)
  socket.destroy()
})

test("only one pending read is permitted", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const pending = reader.read()

  await expect(reader.read()).rejects.toThrow("concurrent workflowd reads are not supported")
  socket.emit("data", frame({ type: "response" }))
  await expect(pending).resolves.toEqual({ type: "response" })
  reader.dispose()
  socket.destroy()
})

test("a simultaneous reader and write failure settles as the write failure without rejection leaks", async () => {
  const socket = new Socket()
  const reader = new IpcFrameReader(socket)
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on("unhandledRejection", onUnhandled)
  Object.defineProperty(socket, "write", {
    configurable: true,
    value: (_chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean => {
      socket.emit("error", new Error("reader failed during write"))
      callback?.(new Error("triggering write failed"))
      return true
    },
  })

  try {
    await expect(phase(reader, { type: "health" })).rejects.toThrow("triggering write failed")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(unhandled).toEqual([])
    expectReaderListenersDetached(socket)
  } finally {
    process.off("unhandledRejection", onUnhandled)
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
