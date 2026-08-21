import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { BrowserEvidenceRegistry } from "../src/browser/browser-evidence.js"

test("closed managed browser receipt is bound to the frozen candidate", async () => {
  const root = join(tmpdir(), `cycle-browser-evidence-${crypto.randomUUID()}`)
  const sessionId = "executor-session"
  const receiptPath = join(root, "evidence", "fixture", "run", "session.json")
  const receiptJson = receipt()
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, receiptJson)
  const receiptDigest = createHash("sha256").update(receiptJson).digest("hex")
  const registry = new BrowserEvidenceRegistry(root)
  try {
    await registry.recordClose(sessionId, { receiptDigest, receiptPath, status: "closed" })
    expect(await registry.attest([sessionId], "a".repeat(64))).toEqual([
      {
        candidate_digest: "a".repeat(64),
        receipt_digest: receiptDigest,
        receipt_json: receiptJson,
        session_id: sessionId,
      },
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("a tool invocation after browser close invalidates the receipt", async () => {
  const root = join(tmpdir(), `cycle-browser-evidence-${crypto.randomUUID()}`)
  const receiptPath = join(root, "evidence", "fixture", "run", "session.json")
  const receiptJson = receipt()
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, receiptJson)
  const registry = new BrowserEvidenceRegistry(root)
  try {
    await registry.recordClose("executor-session", {
      receiptDigest: createHash("sha256").update(receiptJson).digest("hex"),
      receiptPath,
      status: "closed",
    })
    registry.invalidate("executor-session")
    expect(await registry.attest(["executor-session"], "a".repeat(64))).toEqual([])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("restart discovery uses only the deterministic session evidence directory", async () => {
  const root = join(tmpdir(), `cycle-browser-evidence-${crypto.randomUUID()}`)
  const sessionId = "executor-session"
  const identity = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  const receiptPath = join(root, "evidence", identity, crypto.randomUUID(), "session.json")
  const receiptJson = receipt()
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, receiptJson)
  const registry = new BrowserEvidenceRegistry(root)
  try {
    const attestations = await registry.attest([sessionId], "b".repeat(64))
    expect(attestations).toHaveLength(1)
    expect(attestations[0]).toMatchObject({
      candidate_digest: "b".repeat(64),
      receipt_digest: createHash("sha256").update(receiptJson).digest("hex"),
      session_id: sessionId,
    })
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("close result outside the managed evidence root is rejected", async () => {
  const root = join(tmpdir(), `cycle-browser-evidence-${crypto.randomUUID()}`)
  const outside = join(tmpdir(), `cycle-browser-outside-${crypto.randomUUID()}.json`)
  const receiptJson = receipt()
  await mkdir(join(root, "evidence"), { recursive: true })
  await writeFile(outside, receiptJson)
  const registry = new BrowserEvidenceRegistry(root)
  try {
    await expect(
      registry.recordClose("executor-session", {
        receiptDigest: createHash("sha256").update(receiptJson).digest("hex"),
        receiptPath: outside,
        status: "closed",
      }),
    ).rejects.toThrow("outside the managed browser evidence directory")
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(outside, { force: true })
  }
})

function receipt(): string {
  return `${JSON.stringify({
    actions: ["open", "snapshot", "check", "screenshot", "logs", "close"].map((operation) => ({
      digest: createHash("sha256").update(operation).digest("hex"),
      operation,
      timestamp: "2026-08-15T12:00:00.000Z",
      url: "http://127.0.0.1:8766/index.html",
    })),
    logs: [],
  }, null, 2)}\n`
}
