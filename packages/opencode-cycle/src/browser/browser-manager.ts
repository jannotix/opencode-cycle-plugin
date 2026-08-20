import { isIP } from "node:net"

export const BROWSER_OPERATIONS = [
  "open",
  "snapshot",
  "click",
  "fill",
  "press",
  "upload",
  "check",
  "screenshot",
  "logs",
  "close",
] as const

export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number]

export interface BrowserCommand {
  readonly environmentVariable?: string | undefined
  readonly exact?: boolean | undefined
  readonly expectedText?: string | undefined
  readonly expectedUrl?: string | undefined
  readonly fullPage?: boolean | undefined
  readonly key?: string | undefined
  readonly label?: string | undefined
  readonly name?: string | undefined
  readonly operation: BrowserOperation
  readonly path?: string | undefined
  readonly role?: string | undefined
  readonly selector?: string | undefined
  readonly testId?: string | undefined
  readonly text?: string | undefined
  readonly url?: string | undefined
  readonly value?: string | undefined
}

export interface ManagedBrowserSession {
  allowOrigin(origin: string): void
  close(): Promise<unknown>
  execute(command: BrowserCommand): Promise<unknown>
}

export interface BrowserSessionFactory {
  create(input: {
    readonly allowedOrigins: ReadonlySet<string>
    readonly artifactDirectory: string
    readonly sessionId: string
  }): Promise<ManagedBrowserSession>
}

interface BrowserManagerOptions extends BrowserSessionFactory {
  readonly allowedOrigins?: readonly string[]
  readonly artifactDirectory: string
  readonly maxSessions: number
}

interface SessionState {
  readonly approvedOrigins: Set<string>
  readonly browser: ManagedBrowserSession
}

export class BrowserManager {
  readonly #allowedOrigins: ReadonlySet<string>
  readonly #artifactDirectory: string
  readonly #factory: BrowserSessionFactory
  readonly #maximum: number
  readonly #sessions = new Map<string, SessionState>()

  constructor(options: BrowserManagerOptions) {
    if (!Number.isInteger(options.maxSessions) || options.maxSessions < 1 || options.maxSessions > 8) {
      throw new Error("Browser session limit must be between 1 and 8")
    }
    this.#maximum = options.maxSessions
    this.#artifactDirectory = options.artifactDirectory
    this.#factory = options
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((value) => validateBrowserUrl(value).origin),
    )
  }

  async execute(
    sessionId: string,
    command: BrowserCommand,
    approveExternalOrigin: (origin: string) => Promise<void>,
  ): Promise<unknown> {
    if (command.operation === "close") {
      const state = this.#sessions.get(sessionId)
      if (state === undefined) return { status: "not_started" }
      this.#sessions.delete(sessionId)
      return state.browser.close()
    }

    let approvedOrigin: string | undefined
    if (command.operation === "open") {
      const target = validateBrowserUrl(required(command.url, "Browser open requires url"))
      command = { ...command, url: target.href }
      const state = this.#sessions.get(sessionId)
      if (
        !isLoopback(target) &&
        !this.#allowedOrigins.has(target.origin) &&
        !state?.approvedOrigins.has(target.origin)
      ) {
        await approveExternalOrigin(target.origin)
        approvedOrigin = target.origin
      }
    }

    const state = await this.#session(sessionId)
    if (approvedOrigin !== undefined) {
      state.approvedOrigins.add(approvedOrigin)
      state.browser.allowOrigin(approvedOrigin)
    }
    return state.browser.execute(command)
  }

  async dispose(): Promise<void> {
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    await Promise.allSettled(sessions.map((state) => state.browser.close()))
  }

  async #session(sessionId: string): Promise<SessionState> {
    const current = this.#sessions.get(sessionId)
    if (current !== undefined) return current
    if (this.#sessions.size >= this.#maximum) {
      throw new Error("Managed browser session limit reached; close an idle browser session")
    }
    const browser = await this.#factory.create({
      allowedOrigins: this.#allowedOrigins,
      artifactDirectory: this.#artifactDirectory,
      sessionId,
    })
    const state = { approvedOrigins: new Set<string>(), browser }
    this.#sessions.set(sessionId, state)
    return state
  }
}

export function validateBrowserUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new Error("Browser URL is invalid", { cause })
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser navigation supports HTTP or HTTPS only")
  }
  if (url.username || url.password) throw new Error("Browser URLs must not contain credentials")
  return url
}

export function isLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true
  return isIP(hostname) === 4 && hostname.startsWith("127.")
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}
