import { Socket } from "node:net"

export const MAX_IPC_FRAME_BYTES = 8 * 1024 * 1024

type ErrorFactory = (message: string) => Error

export interface IpcConnection {
  readonly reader: IpcFrameReader
  readonly socket: Socket
}

export interface IpcConnectOptions {
  readonly connectTimeoutMillis?: number
  readonly errorFactory?: ErrorFactory
  readonly socketFactory?: () => Socket
}

interface PendingRead {
  readonly reject: (error: Error) => void
  readonly resolve: (message: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export class IpcFrameReader {
  readonly #decoder: FrameDecoder
  readonly #errorFactory: ErrorFactory
  readonly #socket: Socket
  readonly #messages: unknown[] = []
  #pendingRead: PendingRead | undefined
  #terminalError: Error | undefined

  readonly #onClose = (): void => {
    this.#terminate(this.#errorFactory("workflowd disconnected before responding"))
  }

  readonly #onData = (chunk: Buffer): void => {
    try {
      for (const message of this.#decoder.feed(chunk)) {
        const pending = this.#pendingRead
        if (pending === undefined) {
          this.#messages.push(message)
        } else {
          this.#pendingRead = undefined
          clearTimeout(pending.timeout)
          pending.resolve(message)
        }
      }
    } catch (error) {
      this.#terminate(error instanceof Error ? error : new Error(String(error)))
    }
  }

  readonly #onError = (error: Error): void => {
    this.#terminate(error)
  }

  constructor(socket: Socket, errorFactory: ErrorFactory = (message) => new Error(message)) {
    this.#decoder = new FrameDecoder(errorFactory)
    this.#errorFactory = errorFactory
    this.#socket = socket
    socket.on("data", this.#onData)
    socket.once("error", this.#onError)
    socket.once("close", this.#onClose)
  }

  read(timeoutMillis = 10_000): Promise<unknown> {
    const message = this.#messages.shift()
    if (message !== undefined) return Promise.resolve(message)
    if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError)
    if (this.#pendingRead !== undefined) {
      return Promise.reject(this.#errorFactory("concurrent workflowd reads are not supported"))
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pendingRead?.timeout !== timeout) return
        this.#pendingRead = undefined
        reject(this.#errorFactory("workflowd response timed out"))
      }, timeoutMillis)
      this.#pendingRead = { reject, resolve, timeout }
    })
  }

  dispose(): void {
    this.#terminate(this.#errorFactory("workflowd disconnected before responding"))
  }

  #terminate(error: Error): void {
    if (this.#terminalError === undefined) this.#terminalError = error
    this.#socket.off("data", this.#onData)
    this.#socket.off("error", this.#onError)
    this.#socket.off("close", this.#onClose)
    const pending = this.#pendingRead
    if (pending !== undefined) {
      this.#pendingRead = undefined
      clearTimeout(pending.timeout)
      pending.reject(this.#terminalError)
    }
  }
}

export async function connectIpcSocket(
  endpoint: string,
  options: IpcConnectOptions = {},
): Promise<IpcConnection> {
  const socket = (options.socketFactory ?? (() => new Socket()))()
  const errorFactory = options.errorFactory ?? ((message: string) => new Error(message))
  const reader = new IpcFrameReader(socket, errorFactory)
  try {
    await waitForConnect(socket, endpoint, options.connectTimeoutMillis ?? 1_000, errorFactory)
    return { reader, socket }
  } catch (error) {
    reader.dispose()
    socket.destroy()
    throw error
  }
}

function waitForConnect(
  socket: Socket,
  endpoint: string,
  timeoutMillis: number,
  errorFactory: ErrorFactory,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      socket.off("connect", onConnect)
      socket.off("error", onError)
    }
    const onConnect = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const timeout = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(errorFactory("local IPC connection timed out"))
    }, timeoutMillis)
    socket.once("connect", onConnect)
    socket.once("error", onError)
    socket.connect(endpoint)
  })
}

class FrameDecoder {
  readonly #errorFactory: ErrorFactory
  #buffer = Buffer.alloc(0)

  constructor(errorFactory: ErrorFactory) {
    this.#errorFactory = errorFactory
  }

  feed(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    const messages: unknown[] = []
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length === 0 || length > MAX_IPC_FRAME_BYTES) {
        throw this.#errorFactory("workflowd sent an invalid IPC frame size")
      }
      if (this.#buffer.length < 4 + length) break
      const payload = this.#buffer.subarray(4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)
      messages.push(JSON.parse(payload.toString("utf8")))
    }
    if (this.#buffer.length > MAX_IPC_FRAME_BYTES + 4) {
      throw this.#errorFactory("workflowd exceeded the IPC buffer limit")
    }
    return messages
  }
}
