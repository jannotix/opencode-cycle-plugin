import { createHash } from "node:crypto"
import { open, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { ManagedBrowserAttestationInput } from "../client.js"

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/u

interface ClosedReceipt {
  readonly receiptDigest: string
  readonly receiptPath: string
  readonly status: "closed"
}

interface ReceiptRecord {
  readonly invalidated: boolean
  readonly receiptDigest: string
  readonly receiptJson: string
}

export class BrowserEvidenceRegistry {
  readonly #artifactDirectory: string
  readonly #records = new Map<string, ReceiptRecord>()

  constructor(artifactDirectory: string) {
    this.#artifactDirectory = resolve(artifactDirectory)
  }

  async recordClose(sessionId: string, value: unknown): Promise<void> {
    const result = parseCloseReceipt(value)
    const receiptJson = await this.#readContained(result.receiptPath)
    if (digest(receiptJson) !== result.receiptDigest) {
      throw new Error("Managed browser receipt digest does not match its persisted bytes")
    }
    this.#records.set(sessionId, {
      invalidated: false,
      receiptDigest: result.receiptDigest,
      receiptJson,
    })
  }

  invalidate(sessionId: string): void {
    const record = this.#records.get(sessionId)
    if (record !== undefined) this.#records.set(sessionId, { ...record, invalidated: true })
  }

  forget(sessionId: string): void {
    this.#records.delete(sessionId)
  }

  async attest(
    sessionIds: readonly string[],
    candidateDigest: string,
  ): Promise<readonly ManagedBrowserAttestationInput[]> {
    if (!SHA256.test(candidateDigest)) throw new Error("Candidate digest is invalid")
    const attestations: ManagedBrowserAttestationInput[] = []
    for (const sessionId of [...new Set(sessionIds)]) {
      if (!sessionId || sessionId.length > 256) continue
      const current = this.#records.get(sessionId)
      if (current?.invalidated === true) continue
      const records = current === undefined ? await this.#discover(sessionId) : [current]
      for (const record of records) {
        if (attestations.length === 32) return attestations
        attestations.push({
          candidate_digest: candidateDigest,
          receipt_digest: record.receiptDigest,
          receipt_json: record.receiptJson,
          session_id: sessionId,
        })
      }
    }
    return attestations
  }

  async #discover(sessionId: string): Promise<readonly ReceiptRecord[]> {
    const identity = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
    const directory = join(this.#artifactDirectory, "evidence", identity)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const records: ReceiptRecord[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/u.test(entry.name)) continue
      try {
        const receiptJson = await this.#readContained(join(directory, entry.name, "session.json"))
        records.push({ invalidated: false, receiptDigest: digest(receiptJson), receiptJson })
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    return records
  }

  async #readContained(path: string): Promise<string> {
    const root = await realpath(join(this.#artifactDirectory, "evidence"))
    const resolved = await realpath(path)
    const scoped = relative(root, resolved)
    if (!scoped || isAbsolute(scoped) || scoped === ".." || scoped.startsWith(`..\\`) || scoped.startsWith("../")) {
      throw new Error("Managed browser receipt is outside the managed browser evidence directory")
    }
    const handle = await open(resolved, "r")
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size < 1 || before.size > MAX_RECEIPT_BYTES) {
        throw new Error("Managed browser receipt is not a bounded regular file")
      }
      const receiptJson = await handle.readFile({ encoding: "utf8" })
      const after = await handle.stat()
      if (after.size !== before.size || Buffer.byteLength(receiptJson) !== before.size) {
        throw new Error("Managed browser receipt changed while it was read")
      }
      return receiptJson
    } finally {
      await handle.close()
    }
  }
}

function parseCloseReceipt(value: unknown): ClosedReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Managed browser close returned a malformed receipt")
  }
  const result = value as Record<string, unknown>
  if (
    result.status !== "closed" ||
    typeof result.receiptDigest !== "string" ||
    !SHA256.test(result.receiptDigest) ||
    typeof result.receiptPath !== "string" ||
    !result.receiptPath
  ) {
    throw new Error("Managed browser close returned a malformed receipt")
  }
  return result as unknown as ClosedReceipt
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
