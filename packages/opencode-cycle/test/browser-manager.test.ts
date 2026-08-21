import { expect, test } from "bun:test"

import {
  BrowserManager,
  validateBrowserUrl,
  type ManagedBrowserSession,
} from "../src/browser/browser-manager.js"

test("browser URL policy permits local apps and rejects unsafe schemes and embedded credentials", () => {
  expect(validateBrowserUrl("http://localhost:3000/dashboard").origin).toBe(
    "http://localhost:3000",
  )
  expect(validateBrowserUrl("https://127.0.0.1:8443").origin).toBe("https://127.0.0.1:8443")
  expect(() => validateBrowserUrl("file:///etc/passwd")).toThrow("HTTP or HTTPS")
  expect(() => validateBrowserUrl("https://user:secret@example.com")).toThrow("credentials")
})

test("browser sessions are isolated, bounded and require native approval for external origins", async () => {
  const approvals: string[] = []
  const allowed: string[] = []
  const operations: unknown[] = []
  let closes = 0
  const session: ManagedBrowserSession = {
    allowOrigin(origin) {
      allowed.push(origin)
    },
    async close() {
      closes += 1
      return { status: "closed" }
    },
    async execute(command) {
      operations.push(command)
      return { status: "ok" }
    },
  }
  const manager = new BrowserManager({
    artifactDirectory: "C:/evidence",
    async create() {
      return session
    },
    maxSessions: 1,
  })
  const approve = async (origin: string) => {
    approvals.push(origin)
  }

  await manager.execute("one", { operation: "open", url: "http://localhost:3000" }, approve)
  await manager.execute("one", { operation: "open", url: "https://staging.example.com" }, approve)

  expect(approvals).toEqual(["https://staging.example.com"])
  expect(allowed).toContain("https://staging.example.com")
  expect(operations).toHaveLength(2)
  expect(manager.execute("two", { operation: "snapshot" }, approve)).rejects.toThrow(
    "session limit",
  )

  await manager.execute("one", { operation: "close" }, approve)
  expect(closes).toBe(1)
})

test("preconfigured origins avoid repeated approval but do not authorize sibling origins", async () => {
  const approvals: string[] = []
  const manager = new BrowserManager({
    allowedOrigins: ["https://staging.example.com"],
    artifactDirectory: "/evidence",
    async create() {
      return {
        allowOrigin() {},
        async close() {
          return {}
        },
        async execute() {
          return {}
        },
      }
    },
    maxSessions: 1,
  })

  await manager.execute(
    "one",
    { operation: "open", url: "https://staging.example.com/login" },
    async (origin) => approvals.push(origin),
  )
  await manager.execute(
    "one",
    { operation: "open", url: "https://api.example.com" },
    async (origin) => approvals.push(origin),
  )

  expect(approvals).toEqual(["https://api.example.com"])
})
