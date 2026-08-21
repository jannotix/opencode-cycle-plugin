import { expect, test } from "bun:test"

import { resolveHostVersion, type HostVersionFetch } from "../src/host-version.js"

const serverUrl = new URL("http://127.0.0.1:4096")

test("reads the host version from the global health endpoint", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = []
  const fetch: HostVersionFetch = async (input, init) => {
    requests.push({ input: String(input), init })
    return new Response(JSON.stringify({ healthy: true, version: "1.18.18" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    })
  }

  await expect(resolveHostVersion(serverUrl, { fetch })).resolves.toBe("1.18.18")
  expect(requests).toHaveLength(1)
  expect(requests[0]?.input).toBe("http://127.0.0.1:4096/global/health")
  expect(requests[0]?.init?.method).toBe("GET")
  expect(requests[0]?.init?.redirect).toBe("error")
  expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal)
})

test("a redirect response is not followed and fails closed", async () => {
  let requests = 0
  const server = Bun.serve({
    fetch(request) {
      requests += 1
      const url = new URL(request.url)
      if (url.pathname === "/global/health") {
        return Response.redirect(new URL("/redirected", url), 302)
      }
      return Response.json({ healthy: true, version: "1.18.18" })
    },
    port: 0,
  })
  try {
    await expect(
      resolveHostVersion(new URL(`http://127.0.0.1:${server.port}`), { env: {} }),
    ).resolves.toBeUndefined()
    expect(requests).toBe(1)
  } finally {
    server.stop(true)
  }
})

test("an explicit override avoids the health request", async () => {
  let calls = 0
  let environmentReads = 0
  const fetch: HostVersionFetch = async () => {
    calls += 1
    throw new Error("network must not be used")
  }
  const env = new Proxy<Record<string, string | undefined>>(
    {},
    {
      get() {
        environmentReads += 1
        throw new Error("environment must not be used")
      },
    },
  )

  await expect(
    resolveHostVersion(serverUrl, { env, fetch, override: "1.18.16" }),
  ).resolves.toBe("1.18.16")
  expect(calls).toBe(0)
  expect(environmentReads).toBe(0)
})

test("uses the OpenCode Basic authorization contract for the health request", async () => {
  for (const input of [
    {
      env: { OPENCODE_SERVER_PASSWORD: "desktop-secret" },
      expected: `Basic ${Buffer.from("opencode:desktop-secret").toString("base64")}`,
    },
    {
      env: {
        OPENCODE_SERVER_PASSWORD: "serve-secret",
        OPENCODE_SERVER_USERNAME: "workflow-user",
      },
      expected: `Basic ${Buffer.from("workflow-user:serve-secret").toString("base64")}`,
    },
  ]) {
    let authorization: string | null = null
    const fetch: HostVersionFetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization")
      return Response.json({ healthy: true, version: "1.18.18" })
    }

    await expect(resolveHostVersion(serverUrl, { env: input.env, fetch })).resolves.toBe("1.18.18")
    expect(authorization).toBe(input.expected)
  }
})

test("omits authorization when the OpenCode server password is absent", async () => {
  let authorization: string | null = "not-called"
  const fetch: HostVersionFetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization")
    return Response.json({ healthy: true, version: "1.18.18" })
  }

  await expect(resolveHostVersion(serverUrl, { env: {}, fetch })).resolves.toBe("1.18.18")
  expect(authorization).toBeNull()
})

test("never exposes server credentials through probe results or errors", async () => {
  const secret = "credential-that-must-not-escape"
  const fetch: HostVersionFetch = async () => {
    throw new Error(secret)
  }

  const result = await resolveHostVersion(serverUrl, {
    env: { OPENCODE_SERVER_PASSWORD: secret },
    fetch,
  })
  expect(result).toBeUndefined()
  expect(String(result)).not.toContain(secret)
})

test("unreachable and unsuccessful health endpoints do not report a version", async () => {
  const unreachable: HostVersionFetch = async () => {
    throw new Error("connection refused")
  }
  const unsuccessful: HostVersionFetch = async () => new Response(null, { status: 503 })

  await expect(resolveHostVersion(serverUrl, { fetch: unreachable })).resolves.toBeUndefined()
  await expect(resolveHostVersion(serverUrl, { fetch: unsuccessful })).resolves.toBeUndefined()
})

test("malformed health responses do not report a version", async () => {
  const payloads: unknown[] = [
    null,
    {},
    { healthy: false, version: "1.18.18" },
    { healthy: true },
    { healthy: true, version: 11818 },
    { healthy: true, version: " 1.18.18" },
  ]

  for (const payload of payloads) {
    const fetch: HostVersionFetch = async () =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    await expect(resolveHostVersion(serverUrl, { fetch })).resolves.toBeUndefined()
  }

  const invalidJson: HostVersionFetch = async () =>
    new Response("not-json", { headers: { "content-type": "application/json" }, status: 200 })
  await expect(resolveHostVersion(serverUrl, { fetch: invalidJson })).resolves.toBeUndefined()
})

test("non-JSON media types are rejected without permissive substring matching", async () => {
  for (const contentType of ["text/application/json", "application/jsonp", "text/json"]) {
    const fetch: HostVersionFetch = async () =>
      new Response(JSON.stringify({ healthy: true, version: "1.18.18" }), {
        headers: { "content-type": contentType },
        status: 200,
      })
    await expect(resolveHostVersion(serverUrl, { fetch })).resolves.toBeUndefined()
  }

  for (const contentType of [
    "application/json; charset=utf-8",
    "application/health+json",
  ]) {
    const fetch: HostVersionFetch = async () =>
      new Response(JSON.stringify({ healthy: true, version: "1.18.18" }), {
        headers: { "content-type": contentType },
        status: 200,
      })
    await expect(resolveHostVersion(serverUrl, { fetch })).resolves.toBe("1.18.18")
  }
})

test("rejected status and media type cancel the body without reading it", async () => {
  for (const responseData of [
    { contentType: "application/json", ok: false },
    { contentType: "text/plain", ok: true },
  ]) {
    let cancelled = false
    let reads = 0
    const response = {
      body: {
        cancel() {
          cancelled = true
          return Promise.resolve()
        },
        getReader() {
          reads += 1
          throw new Error("body must not be read")
        },
      },
      headers: new Headers({ "content-type": responseData.contentType }),
      ok: responseData.ok,
    } as unknown as Response
    const fetch: HostVersionFetch = async () => response

    await expect(resolveHostVersion(serverUrl, { fetch })).resolves.toBeUndefined()
    expect(reads).toBe(0)
    expect(cancelled).toBeTrue()
  }
})

test("content length above the limit is rejected before reading the body", async () => {
  let cancelled = false
  let reads = 0
  const response = {
    body: {
      cancel() {
        cancelled = true
        return Promise.resolve()
      },
      getReader() {
        reads += 1
        throw new Error("body must not be read")
      },
    },
    headers: new Headers({
      "content-length": "4097",
      "content-type": "application/json",
    }),
    ok: true,
  } as unknown as Response
  const fetch: HostVersionFetch = async () => response

  await expect(resolveHostVersion(serverUrl, { fetch })).resolves.toBeUndefined()
  expect(reads).toBe(0)
  expect(cancelled).toBeTrue()
})

test("a chunked response is cancelled when its cumulative bytes exceed the limit", async () => {
  let chunk = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
    pull(controller) {
      controller.enqueue(new Uint8Array(chunk++ === 0 ? 3_000 : 2_000))
    },
  })
  const fetch: HostVersionFetch = async () =>
    new Response(body, { headers: { "content-type": "application/json" }, status: 200 })

  await expect(resolveHostVersion(serverUrl, { fetch })).resolves.toBeUndefined()
  expect(cancelled).toBeTrue()
})

test("a stalled health request is aborted at the configured timeout", async () => {
  let aborted = false
  const fetch: HostVersionFetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true
          reject(init.signal?.reason)
        },
        { once: true },
      )
    })

  await expect(resolveHostVersion(serverUrl, { fetch, timeoutMs: 5 })).resolves.toBeUndefined()
  expect(aborted).toBeTrue()
})

test("a stalled response body is cancelled at the configured timeout", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
    pull() {
      return new Promise(() => undefined)
    },
  })
  const fetch: HostVersionFetch = async () =>
    new Response(body, { headers: { "content-type": "application/json" }, status: 200 })

  await expect(resolveHostVersion(serverUrl, { fetch, timeoutMs: 5 })).resolves.toBeUndefined()
  expect(cancelled).toBeTrue()
  expect(body.locked).toBeFalse()
})

test("a missing server URL does not start a request", async () => {
  let calls = 0
  const fetch: HostVersionFetch = async () => {
    calls += 1
    return new Response()
  }

  await expect(resolveHostVersion(undefined, { fetch })).resolves.toBeUndefined()
  expect(calls).toBe(0)
})
