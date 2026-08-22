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
  readonly kind: "passive" | "phase"
  readonly reject: (error: Error) => void
  readonly resolve: (message: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

interface QueuedFrame {
  readonly encodedBytes: number
  readonly message: unknown
}

interface DecodeBudget {
  readonly maxQueuedBytes: number
  readonly maxQueuedFrames: number
  readonly pendingKind: "none" | PendingRead["kind"]
}

interface StagedDecode {
  readonly frames: readonly QueuedFrame[]
  readonly residue: Buffer
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
      const pending = this.#pendingRead
      const staged = this.#decoder.stage(chunk, {
        maxQueuedBytes: this.#limits.maxQueuedBytes - this.#queuedBytes,
        maxQueuedFrames: this.#limits.maxQueuedFrames - this.#messages.length,
        pendingKind: pending?.kind ?? "none",
      })
      this.#decoder.commit(staged)
      if (staged.frames.length === 0) return

      const queueStart = pending === undefined ? 0 : 1
      for (let index = queueStart; index < staged.frames.length; index += 1) {
        const frame = staged.frames[index]
        if (frame === undefined) continue
        this.#messages.push(frame)
        this.#queuedBytes += frame.encodedBytes
      }
      if (pending !== undefined) {
        const response = staged.frames[0]
        if (response === undefined) return
        this.#pendingRead = undefined
        clearTimeout(pending.timeout)
        pending.resolve(response.message)
      }
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
    return this.#waitForFrame(timeoutMillis, "passive")
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
    if (this.#messages.length !== 0 || this.#decoder.bufferedBytes !== 0) {
      const error = this.#errorFactory(
        "workflowd sent an IPC frame before the client initiated the protocol phase",
      )
      this.#terminate(error)
      throw error
    }
    return this.#waitForFrame(timeoutMillis, "phase")
  }

  #waitForFrame(timeoutMillis: number, kind: PendingRead["kind"]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pendingRead?.timeout !== timeout) return
        this.#terminate(this.#errorFactory("workflowd response timed out"))
      }, timeoutMillis)
      this.#pendingRead = { kind, reject, resolve, timeout }
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
  #buffer: Buffer = Buffer.alloc(0)

  constructor(errorFactory: ErrorFactory) {
    this.#errorFactory = errorFactory
  }

  clear(): void {
    this.#buffer = Buffer.alloc(0)
  }

  get bufferedBytes(): number {
    return this.#buffer.length
  }

  commit(staged: StagedDecode): void {
    this.#buffer = staged.residue
  }

  stage(chunk: Buffer, budget: DecodeBudget): StagedDecode {
    const source = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames: QueuedFrame[] = []
    let offset = 0
    let stagedQueuedBytes = 0
    let stagedQueuedFrames = 0
    while (source.length - offset >= 4) {
      const length = source.readUInt32BE(offset)
      if (length === 0 || length > MAX_IPC_FRAME_BYTES) {
        throw this.#errorFactory("workflowd sent an invalid IPC frame size")
      }
      const encodedBytes = 4 + length
      if (source.length - offset < encodedBytes) break
      const payload = source.subarray(offset + 4, offset + encodedBytes)
      const deliversPending = budget.pendingKind !== "none" && frames.length === 0
      if (!deliversPending && budget.pendingKind !== "phase") {
        if (stagedQueuedBytes + encodedBytes > budget.maxQueuedBytes) {
          throw this.#errorFactory("workflowd exceeded the queued IPC byte limit")
        }
        if (stagedQueuedFrames >= budget.maxQueuedFrames) {
          throw this.#errorFactory("workflowd exceeded the queued IPC frame limit")
        }
      }
      const message = JSON.parse(payload.toString("utf8"))
      if (!deliversPending && budget.pendingKind === "phase") {
        throw this.#errorFactory("workflowd sent more than one IPC frame for a protocol phase")
      }
      if (!deliversPending) {
        stagedQueuedBytes += encodedBytes
        stagedQueuedFrames += 1
      }
      frames.push({ encodedBytes, message })
      offset += encodedBytes
    }
    const residueView = source.subarray(offset)
    if (residueView.length > MAX_IPC_FRAME_BYTES + 4) {
      throw this.#errorFactory("workflowd exceeded the IPC buffer limit")
    }
    if (budget.pendingKind === "phase" && frames.length !== 0 && residueView.length !== 0) {
      throw this.#errorFactory("workflowd sent more than one IPC frame for a protocol phase")
    }
    const residue =
      residueView.length === 0
        ? Buffer.alloc(0)
        : offset === 0
          ? source
          : Buffer.from(residueView)
    return { frames, residue }
  }
}
