import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import type { Part } from "@opencode-ai/sdk"

export interface CapturedWorkflowRequest {
  readonly attachmentHashes: readonly string[]
  readonly originalRequest: string
}

export async function captureWorkflowRequest(
  parts: readonly Part[],
  worktree: string,
): Promise<CapturedWorkflowRequest> {
  const originalRequest = parts
    .filter(
      (part): part is Extract<Part, { type: "text" }> =>
        part.type === "text" && part.synthetic !== true && part.ignored !== true,
    )
    .map((part) => part.text)
    .join("")
  if (!originalRequest) throw new Error("Cycle requires a non-empty original user request")
  const attachments = parts.filter(
    (part): part is Extract<Part, { type: "file" }> => part.type === "file",
  )
  const attachmentHashes = await Promise.all(
    attachments.map((part) => attachmentDigest(part, worktree)),
  )
  return { attachmentHashes, originalRequest }
}

async function attachmentDigest(
  part: Extract<Part, { type: "file" }>,
  worktree: string,
): Promise<string> {
  if (part.url.startsWith("data:")) {
    const separator = part.url.indexOf(",")
    if (separator < 0) throw new Error("Attachment data URL is malformed")
    const metadata = part.url.slice(0, separator)
    const body = part.url.slice(separator + 1)
    const bytes = metadata.endsWith(";base64")
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body))
    return createHash("sha256").update(bytes).digest("hex")
  }
  if (part.source?.path !== undefined) {
    const root = resolve(worktree)
    const candidate = resolve(root, part.source.path)
    const relativePath = relative(root, candidate)
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("Attachment source path escapes the project worktree")
    }
    return createHash("sha256").update(await readFile(candidate)).digest("hex")
  }
  return createHash("sha256")
    .update(JSON.stringify({ filename: part.filename ?? null, mime: part.mime, url: part.url }))
    .digest("hex")
}
