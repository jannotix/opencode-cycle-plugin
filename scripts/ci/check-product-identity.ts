import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const retiredProduct = ["OpenCode", "WorkFlow"].join(" ")
const retiredPackage = ["opencode", "workflow"].join("-")
const retiredPluginExport = `OpenCode${"Workflow"}`
const retiredRole = (role: string) => `WorkFlow ${role}`
const retiredCommand = `/${"workflow"}`

const FORBIDDEN = [
  retiredProduct,
  retiredPackage,
  retiredPluginExport,
  retiredRole("Architect"),
  retiredRole("Executor"),
  retiredRole("Functional Reviewer"),
  retiredRole("Security and Architecture Reviewer"),
  retiredRole("Arbiter"),
  retiredCommand,
  `workflow_${"control"}`,
  `workflow_${"role"}`,
  `workflow_${"browser"}`,
] as const

type Forbidden = (typeof FORBIDDEN)[number]

type ApprovedOccurrence = Readonly<{
  count: number
  needle: string
}>

const protocolV1 = (suffix: string) => `${retiredPackage}/${suffix}/v1`

const APPROVED_PROTOCOL_OCCURRENCES: Readonly<Record<string, readonly ApprovedOccurrence[]>> = {
  "crates/workflow-code-intel/src/graph/model.rs": [{ count: 1, needle: protocolV1("code-graph") }],
  "crates/workflow-core/src/candidate.rs": [{ count: 1, needle: protocolV1("candidate") }],
  "crates/workflow-core/src/id.rs": [{ count: 1, needle: protocolV1("project") }],
  "crates/workflow-core/src/receipt.rs": [{ count: 1, needle: protocolV1("arbitration-receipt") }],
  "crates/workflow-core/src/request.rs": [
    { count: 1, needle: protocolV1("request-amendment") },
    { count: 1, needle: protocolV1("request") },
  ],
  "crates/workflow-ledger/src/chain.rs": [{ count: 1, needle: `${retiredPackage}-ledger-entry-v1` }],
  "crates/workflow-ledger/src/checkpoint.rs": [{ count: 1, needle: `${retiredPackage}-ledger-checkpoint-v1` }],
  "crates/workflowd/src/verification/runner.rs": [{ count: 1, needle: protocolV1("verification-output") }],
}

const APPROVED_COMPATIBILITY_OCCURRENCES: Readonly<Record<string, readonly ApprovedOccurrence[]>> = {
  "crates/workflowd/src/candidate.rs": [{ count: 1, needle: `${retiredPackage}-delivery` }],
}

const APPROVED_HISTORICAL_COUNTS: Readonly<Partial<Record<string, Readonly<Partial<Record<Forbidden, number>>>>>> = {}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".githooks",
  ".superpowers",
  "candidate",
  "dist",
  "examples",
  "local",
  "node_modules",
  "plans",
  "releases",
  "specs",
  "superpowers",
  "target",
  "test",
  "tests",
])
const BINARY_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "pdf",
  "png",
  "wasm",
  "webp",
])
const FILE_READ_CONCURRENCY = 8
const VENDORED_THIRD_PARTY_SCHEMA_PATHS = new Set([
  "scripts/release/schema/bom-1.6.schema.json",
  "scripts/release/schema/jsf-0.82.schema.json",
  "scripts/release/schema/spdx.schema.json",
])

async function filesBelow(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await filesBelow(root, path)))
      continue
    }
    if (
      entry.isFile() &&
      entry.name !== "AGENTS.md" &&
      entry.name !== "PRODUCT.md" &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(path)
    }
  }
  return files
}

function isKnownBinaryPath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return extension !== undefined && BINARY_EXTENSIONS.has(extension)
}

function decodeText(content: Buffer): string | undefined {
  const encoding =
    content[0] === 0xff && content[1] === 0xfe
      ? "utf-16le"
      : content[0] === 0xfe && content[1] === 0xff
        ? "utf-16be"
        : "utf-8"
  const offset = encoding === "utf-8" ? (content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf ? 3 : 0) : 2
  if (offset === 0 && content.includes(0)) return undefined
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(content.subarray(offset))
  } catch {
    return undefined
  }
}

function countToken(text: string, token: Forbidden | string): number {
  if (token === retiredCommand) return [...text.matchAll(new RegExp(`${retiredCommand}(?![A-Za-z0-9_-])`, "gu"))].length
  return text.split(token).length - 1
}

function approvedOccurrences(path: string): readonly ApprovedOccurrence[] {
  return [
    ...(APPROVED_PROTOCOL_OCCURRENCES[path] ?? []),
    ...(APPROVED_COMPATIBILITY_OCCURRENCES[path] ?? []),
  ]
}

async function mapBounded<T, R>(
  values: readonly T[],
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(FILE_READ_CONCURRENCY, values.length) },
    async () => {
      for (;;) {
        const index = nextIndex
        nextIndex += 1
        if (index >= values.length) return
        results[index] = await worker(values[index]!)
      }
    },
  )
  await Promise.all(workers)
  return results
}

async function auditFile(root: string, path: string): Promise<string[]> {
  const content = await readFile(join(root, path))
  const text = decodeText(content)
  if (text === undefined) return [`${path}: unsupported text encoding`]

  const findings: string[] = []
  const approved = approvedOccurrences(path)
  for (const occurrence of approved) {
    const observed = countToken(text, occurrence.needle)
    if (observed !== occurrence.count) {
      findings.push(`${path}: approved ${occurrence.needle} count is ${observed}, expected ${occurrence.count}`)
    }
  }
  const historical = APPROVED_HISTORICAL_COUNTS[path] ?? {}
  for (const token of FORBIDDEN) {
    const approvedCount = approved
      .filter((occurrence) => occurrence.needle.includes(token))
      .reduce((total, occurrence) => total + occurrence.count, 0)
    const expected = (historical[token] ?? 0) + approvedCount
    const observed = countToken(text, token)
    if (observed !== expected) {
      findings.push(
        expected === 0
          ? `${path}: ${token}`
          : `${path}: ${token} count is ${observed}, expected ${expected}`,
      )
    }
  }
  return findings
}

export async function auditProductIdentity(
  root: string,
  { requireApprovedPaths = false }: { requireApprovedPaths?: boolean } = {},
): Promise<string[]> {
  const findings: string[] = []
  const paths = (await filesBelow(root)).map((path) => path.replaceAll("\\", "/")).sort()
  const pathSet = new Set(paths)
  if (requireApprovedPaths) {
    for (const path of [
      ...Object.keys(APPROVED_PROTOCOL_OCCURRENCES),
      ...Object.keys(APPROVED_COMPATIBILITY_OCCURRENCES),
      ...Object.keys(APPROVED_HISTORICAL_COUNTS),
    ]) {
      if (!pathSet.has(path)) findings.push(`${path}: approved compatibility path is missing`)
    }
  }
  const scannedPaths = paths.filter(
    (path) => !isKnownBinaryPath(path) && !VENDORED_THIRD_PARTY_SCHEMA_PATHS.has(path),
  )
  for (const fileFindings of await mapBounded(scannedPaths, (path) => auditFile(root, path))) {
    findings.push(...fileFindings)
  }
  return findings.sort()
}

const invokedPath = process.argv[1] === undefined ? undefined : fileURLToPath(import.meta.url)
if (invokedPath !== undefined && process.argv[1] === invokedPath) {
  const findings = await auditProductIdentity(process.cwd(), { requireApprovedPaths: true })
  if (findings.length > 0) {
    console.error(findings.join("\n"))
    process.exitCode = 1
  }
}
