import { Socket } from "node:net"

export const MAX_IPC_FRAME_BYTES = 8 * 1024 * 1024
export const MAX_QUEUED_IPC_FRAMES = 3
export const MAX_QUEUED_IPC_BYTES = MAX_QUEUED_IPC_FRAMES * (MAX_IPC_FRAME_BYTES + 4)

type ErrorFactory = (message: string) => Error

export interface IpcReaderLimits {
  readonly maxQueuedBytes: number
  readonly maxQueuedFrames: number
}

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

interface QueuedFrame {
  readonly encodedBytes: number
  readonly message: unknown
}

type ReadOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly error: Error; readonly ok: false }

export class IpcFrameReader {
  readonly #decoder: FrameDecoder
  readonly #errorFactory: ErrorFactory
  readonly #limits: IpcReaderLimits
  readonly #socket: Socket
  readonly #messages: QueuedFrame[] = []
  #pendingRead: PendingRead | undefined
  #queuedBytes = 0
  #terminalError: Error | undefined

  readonly #onClose = (): void => {
    this.#terminate(this.#errorFactory("workflowd disconnected before responding"))
  }

  readonly #onData = (chunk: Buffer): void => {
    try {
      this.#decoder.feed(chunk, (frame) => {
        if (this.#terminalError !== undefined) return false
        const pending = this.#pendingRead
        if (pending === undefined) {
          const queuedBytes = this.#queuedBytes + frame.encodedBytes
          if (queuedBytes > this.#limits.maxQueuedBytes) {
            this.#terminate(this.#errorFactory("workflowd exceeded the queued IPC byte limit"))
            return false
          }
          if (this.#messages.length >= this.#limits.maxQueuedFrames) {
            this.#terminate(this.#errorFactory("workflowd exceeded the queued IPC frame limit"))
            return false
          }
          this.#messages.push(frame)
          this.#queuedBytes = queuedBytes
        } else {
          this.#pendingRead = undefined
          clearTimeout(pending.timeout)
          pending.resolve(frame.message)
        }
        return true
      })
    } catch (error) {
      this.#terminate(error instanceof Error ? error : new Error(String(error)))
    }
  }

  readonly #onError = (error: Error): void => {
    this.#terminate(error)
  }

  constructor(
    socket: Socket,
    errorFactory: ErrorFactory = (message) => new Error(message),
    limits: IpcReaderLimits = {
      maxQueuedBytes: MAX_QUEUED_IPC_BYTES,
      maxQueuedFrames: MAX_QUEUED_IPC_FRAMES,
    },
  ) {
    if (
      !Number.isSafeInteger(limits.maxQueuedBytes) ||
      limits.maxQueuedBytes < 1 ||
      !Number.isSafeInteger(limits.maxQueuedFrames) ||
      limits.maxQueuedFrames < 1
    ) {
      throw errorFactory("workflowd IPC queue limits are invalid")
    }
    this.#decoder = new FrameDecoder(errorFactory)
    this.#errorFactory = errorFactory
    this.#limits = {
      maxQueuedBytes: limits.maxQueuedBytes,
      maxQueuedFrames: limits.maxQueuedFrames,
    }
    this.#socket = socket
    socket.on("data", this.#onData)
    socket.once("error", this.#onError)
    socket.once("close", this.#onClose)
  }

  read(timeoutMillis = 10_000): Promise<unknown> {
    if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError)
    const frame = this.#messages.shift()
    if (frame !== undefined) {
      this.#queuedBytes -= frame.encodedBytes
      return Promise.resolve(frame.message)
    }
    if (this.#pendingRead !== undefined) {
      return Promise.reject(this.#errorFactory("concurrent workflowd reads are not supported"))
    }
    return this.#waitForFrame(timeoutMillis)
  }

  async writeAndRead(frame: Buffer, timeoutMillis = 10_000): Promise<unknown> {
    const response = this.#armPhaseRead(timeoutMillis)
    const outcome = response.then<ReadOutcome, ReadOutcome>(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ error: asError(error), ok: false }),
    )
    try {
      await writeFrame(this.#socket, frame)
    } catch (error) {
      const writeError = asError(error)
      this.#terminate(writeError)
      await outcome
      throw writeError
    }
    const result = await outcome
    if (!result.ok) throw result.error
    return result.value
  }

  dispose(): void {
    this.#terminate(this.#errorFactory("workflowd disconnected before responding"))
  }

  #armPhaseRead(timeoutMillis: number): Promise<unknown> {
    if (this.#terminalError !== undefined) throw this.#terminalError
    if (this.#pendingRead !== undefined) {
      throw this.#errorFactory("concurrent workflowd reads are not supported")
    }
    if (this.#messages.length !== 0) {
      const error = this.#errorFactory(
        "workflowd sent an IPC frame before the client initiated the protocol phase",
      )
      this.#terminate(error)
      throw error
    }
    return this.#waitForFrame(timeoutMillis)
  }

  #waitForFrame(timeoutMillis: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pendingRead?.timeout !== timeout) return
        this.#terminate(this.#errorFactory("workflowd response timed out"))
      }, timeoutMillis)
      this.#pendingRead = { reject, resolve, timeout }
    })
  }

  #terminate(error: Error): void {
    if (this.#terminalError === undefined) this.#terminalError = error
    this.#socket.off("data", this.#onData)
    this.#socket.off("error", this.#onError)
    this.#socket.off("close", this.#onClose)
    this.#decoder.clear()
    this.#messages.length = 0
    this.#queuedBytes = 0
    const pending = this.#pendingRead
    if (pending !== undefined) {
      this.#pendingRead = undefined
      clearTimeout(pending.timeout)
      pending.reject(this.#terminalError)
    }
  }
}

function writeFrame(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => {
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
  })
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
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

  clear(): void {
    this.#buffer = Buffer.alloc(0)
  }

  feed(chunk: Buffer, onFrame: (frame: QueuedFrame) => boolean): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length === 0 || length > MAX_IPC_FRAME_BYTES) {
        throw this.#errorFactory("workflowd sent an invalid IPC frame size")
      }
      if (this.#buffer.length < 4 + length) break
      const payload = this.#buffer.subarray(4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)
      if (
        !onFrame({
          encodedBytes: 4 + length,
          message: JSON.parse(payload.toString("utf8")),
        })
      ) {
        return
      }
    }
    if (this.#buffer.length > MAX_IPC_FRAME_BYTES + 4) {
      throw this.#errorFactory("workflowd exceeded the IPC buffer limit")
    }
  }
}
