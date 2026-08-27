import type { HostClient } from "../host.js"
import type { HostSessionStatus } from "../host.js"

type PromptOptions = Parameters<HostClient["session"]["prompt"]>[0]
type PromptData = NonNullable<
  Awaited<ReturnType<HostClient["session"]["prompt"]>>["data"]
>

interface PromptWaitOptions {
  readonly absoluteWaitMs?: number
  readonly maximumWaitMs?: number
  readonly pollIntervalMs?: number
}

export const ROLE_PROMPT_LIMITS = {
  absoluteWaitMs: 2 * 60 * 60 * 1_000,
  maximumIdleWaitMs: 30 * 60 * 1_000,
  pollIntervalMs: 3_000,
} as const

const MAXIMUM_CONSECUTIVE_POLL_FAILURES = 5

export async function promptSessionAndWait(
  client: HostClient,
  options: PromptOptions,
  waitOptions: PromptWaitOptions = {},
): Promise<PromptData> {
  const session = client.session
  const signal = options.signal ?? undefined
  if (
    typeof session.promptAsync !== "function" ||
    typeof session.status !== "function" ||
    typeof session.messages !== "function"
  ) {
    let completed = false
    try {
      const response = await session.prompt(options)
      if (response.data === undefined) throw new Error("OpenCode session did not return a result")
      completed = true
      return response.data
    } finally {
      if (!completed) await abortSession(session, options.path.id, options.query?.directory)
    }
  }

  const sessionId = options.path.id
  const directory = options.query?.directory
  let asynchronousPromptDispatched = false
  let completed = false
  try {
    const baseline = await session.messages({
      path: { id: sessionId },
      query: { ...(directory === undefined ? {} : { directory }), limit: 100 },
      ...(signal === undefined ? {} : { signal }),
    })
    if (baseline.data === undefined) throw new Error("OpenCode could not read the session baseline")
    const knownMessageIds = new Set(baseline.data.map((message) => message.info.id))
    asynchronousPromptDispatched = true
    const accepted = await session.promptAsync(options)
    if ("error" in accepted && accepted.error !== undefined) {
      throw new Error("OpenCode rejected the asynchronous role prompt")
    }

    const started = Date.now()
    const idleBudget = waitOptions.maximumWaitMs ?? ROLE_PROMPT_LIMITS.maximumIdleWaitMs
    const absoluteDeadline = started + (waitOptions.absoluteWaitMs ?? ROLE_PROMPT_LIMITS.absoluteWaitMs)
    let idleDeadline = started + idleBudget
    const pollIntervalMs = waitOptions.pollIntervalMs ?? ROLE_PROMPT_LIMITS.pollIntervalMs
    let consecutiveFailures = 0
    for (;;) {
      signal?.throwIfAborted()
      if (Date.now() >= absoluteDeadline || Date.now() >= idleDeadline) {
        throw new Error("OpenCode role session exceeded the maximum execution time")
      }

      let response: PromptData | undefined
      let status: HostSessionStatus | undefined
      try {
        const statusResponse = await session.status({
          query: directory === undefined ? {} : { directory },
          ...(signal === undefined ? {} : { signal }),
        })
        if (statusResponse.data === undefined) {
          throw new Error("OpenCode could not read the role session status")
        }
        status = statusResponse.data[sessionId]
        if (status?.type === "busy" || status?.type === "retry") {
          consecutiveFailures = 0
          idleDeadline = Math.min(Date.now() + idleBudget, absoluteDeadline)
          await delay(pollIntervalMs, signal)
          continue
        }
        const messagesResponse = await session.messages({
          path: { id: sessionId },
          query: { ...(directory === undefined ? {} : { directory }), limit: 100 },
          ...(signal === undefined ? {} : { signal }),
        })
        if (messagesResponse.data === undefined) {
          throw new Error("OpenCode could not read the completed role response")
        }
        consecutiveFailures = 0

        response = messagesResponse.data
          .filter(
            (message): message is PromptData =>
              message.info.role === "assistant" &&
              message.info.summary !== true &&
              !knownMessageIds.has(message.info.id),
          )
          .at(-1)
      } catch (error) {
        signal?.throwIfAborted()
        consecutiveFailures += 1
        if (consecutiveFailures > MAXIMUM_CONSECUTIVE_POLL_FAILURES) throw error
      }
      if (
        response !== undefined &&
        response.info.time.completed !== undefined &&
        status?.type !== "busy" &&
        status?.type !== "retry"
      ) {
        if (response.info.error !== undefined) {
          throw new Error(`OpenCode role session failed: ${response.info.error.name}`)
        }
        completed = true
        return response
      }
      await delay(pollIntervalMs, signal)
    }
  } finally {
    if (asynchronousPromptDispatched && !completed) await abortSession(session, sessionId, directory)
  }
}

async function abortSession(
  session: HostClient["session"],
  sessionId: string,
  directory: string | undefined,
): Promise<void> {
  if (typeof session.abort !== "function") return
  try {
    await session.abort({
      path: { id: sessionId },
      query: directory === undefined ? {} : { directory },
    })
  } catch {}
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    signal?.addEventListener("abort", aborted, { once: true })

    function done() {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }

    function aborted() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
  })
}
