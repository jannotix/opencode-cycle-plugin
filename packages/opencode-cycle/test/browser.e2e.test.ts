import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BrowserManager } from "../src/browser/browser-manager.js"
import { ManagedBrowserSessionFactory } from "../src/browser/managed-browser-session.js"

test(
  "managed browser performs real local UI checks and captures external evidence",
  async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "opencode-cycle-browser-"))
    const server = Bun.serve({
      fetch() {
        return new Response(`<!doctype html>
          <html lang="en">
            <head><title>Workflow browser test</title></head>
            <body>
              <main>
                <h1>Ready</h1>
                <button onclick="document.querySelector('h1').textContent='Completed'">Run</button>
              </main>
            </body>
          </html>`, { headers: { "content-type": "text/html; charset=utf-8" } })
      },
      port: 0,
    })
    const factory = new ManagedBrowserSessionFactory({
      ...(process.env.PUPPETEER_EXECUTABLE_PATH === undefined
        ? {}
        : { browserExecutable: process.env.PUPPETEER_EXECUTABLE_PATH }),
      headless: true,
      projectDirectory: import.meta.dir,
    })
    const manager = new BrowserManager({
      artifactDirectory: artifacts,
      create: (input) => factory.create(input),
      maxSessions: 1,
    })
    const approve = async () => {
      throw new Error("Local browser test must not request external approval")
    }

    const forceRemove = async (path: string) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(path, { force: true, recursive: true })
          return
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EBUSY"
          ) {
            await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)))
            continue
          }
          throw error
        }
      }
      await rm(path, { force: true, recursive: true }).catch(() => {})
    }

    try {
      const url = `http://127.0.0.1:${server.port}`
      await manager.execute("session", { operation: "open", url }, approve)
      const snapshot = await manager.execute("session", { operation: "snapshot" }, approve)
      expect(JSON.stringify(snapshot)).toContain("Ready")
      await manager.execute(
        "session",
        { name: "Run", operation: "click", role: "button" },
        approve,
      )
      const check = await manager.execute(
        "session",
        { expectedText: "Completed", operation: "check", role: "heading" },
        approve,
      )
      expect(check).toMatchObject({ status: "passed" })
      const namedCheck = await manager.execute(
        "session",
        { exact: true, expectedText: "Completed", name: "Completed", operation: "check" },
        approve,
      )
      expect(namedCheck).toMatchObject({ status: "passed" })
      const labelledCheck = await manager.execute(
        "session",
        {
          expectedText: "Completed",
          label: "Confirm the completion result is visible",
          operation: "check",
        },
        approve,
      )
      expect(labelledCheck).toMatchObject({ status: "passed" })
      const screenshot = await manager.execute(
        "session",
        { operation: "screenshot" },
        approve,
      )
      expect(screenshot).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
      const closed = await manager.execute("session", { operation: "close" }, approve)
      const receiptPath = (closed as { receiptPath?: unknown }).receiptPath
      expect(typeof receiptPath).toBe("string")
      const receipt = JSON.parse(await readFile(receiptPath as string, "utf8"))
      expect(closed).toMatchObject({
        receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        receiptPath,
        status: "closed",
      })
      expect(receipt.actions.at(-1)?.operation).toBe("close")
    } finally {
      await manager.dispose()
      server.stop(true)
      await forceRemove(artifacts)
    }
  },
  30_000,
)
