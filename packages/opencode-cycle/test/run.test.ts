import { expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { captureWorkflowRequest } from "../src/commands/run.js"

test("request capture preserves exact text and hashes attachment bytes", async () => {
  const result = await captureWorkflowRequest(
    [
      { ignored: false, text: "First line\r\n", type: "text" },
      { synthetic: false, text: "Second line", type: "text" },
      {
        filename: "requirements.txt",
        mime: "text/plain",
        type: "file",
        url: "data:text/plain;base64,YXR0YWNobWVudCBieXRlcw==",
      },
    ] as never,
    "C:/project",
  )

  expect(result.originalRequest).toBe("First line\r\nSecond line")
  expect(result.attachmentHashes).toEqual([
    createHash("sha256").update("attachment bytes").digest("hex"),
  ])
})

test("synthetic and ignored text never replaces the original request", async () => {
  const result = await captureWorkflowRequest(
    [
      { synthetic: true, text: "Synthetic instructions", type: "text" },
      { ignored: true, text: "Ignored instructions", type: "text" },
      { text: "User request", type: "text" },
    ] as never,
    "C:/project",
  )

  expect(result.originalRequest).toBe("User request")
})
