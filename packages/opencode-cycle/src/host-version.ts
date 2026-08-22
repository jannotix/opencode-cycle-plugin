import { Buffer } from "node:buffer"
import { MIMEType } from "node:util"

const DEFAULT_TIMEOUT_MS = 1_000
const MAX_RESPONSE_BYTES = 4_096

type HostVersionEnvironment = Readonly<{
  readonly OPENCODE_SERVER_PASSWORD?: string | undefined
  readonly OPENCODE_SERVER_USERNAME?: string | undefined
}>

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>

export type HostVersionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface HostVersionOptions {
  readonly env?: HostVersionEnvironment
  readonly fetch?: HostVersionFetch
  readonly override?: string
  readonly timeoutMs?: number
}

function authorizationHeader(env: HostVersionEnvironment | NodeJS.ProcessEnv): string | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = env.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false
  try {
    const mime = new MIMEType(value)
    return (
      mime.type === "application" &&
      (mime.subtype === "json" || mime.subtype.endsWith("+json"))
    )
  } catch {
    return false
  }
}

function cancelStream(stream: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>) {
  try {
    void stream.cancel().catch(() => undefined)
  } catch {}
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  if (signal.aborted) {
    cancelStream(reader)
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cancelStream(reader)
      reject(signal.reason)
    }
    signal.addEventListener("abort", aborted, { once: true })
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

async function readLimitedBody(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES) {
      if (response.body !== null) cancelStream(response.body)
      return undefined
    }
  }
  if (response.body === null) return undefined

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await readChunk(reader, signal)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        cancelStream(reader)
        return undefined
      }
      chunks.push(chunk.value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export async function resolveHostVersion(
  serverUrl: URL | undefined,
  options: HostVersionOptions = {},
): Promise<string | undefined> {
  if (options.override !== undefined) return options.override
  if (!(serverUrl instanceof URL)) return undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    const authorization = authorizationHeader(options.env ?? process.env)
    const response = await fetch(new URL("/global/health", serverUrl), {
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok || !isJsonMediaType(response.headers.get("content-type"))) {
      if (response.body !== null) cancelStream(response.body)
      return undefined
    }
    const text = await readLimitedBody(response, controller.signal)
    if (text === undefined) return undefined
    const payload: unknown = JSON.parse(text)
    if (typeof payload !== "object" || payload === null) return undefined
    const health = payload as Record<string, unknown>
    if (health.healthy !== true || typeof health.version !== "string") return undefined
    if (health.version.length === 0 || health.version.length > 64) return undefined
    return health.version.trim() === health.version ? health.version : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}
