import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { auditProductIdentity } from "./check-product-identity.js"
import { NATIVE_PACKAGE_NAMES, SHIPPED_NATIVE_PACKAGE_NAMES } from "../product-identity.js"

const legacyProduct = ["OpenCode", "WorkFlow"].join(" ")
const legacyPackage = ["opencode", "workflow"].join("-")
const legacyPluginExport = `OpenCode${"Workflow"}`
const legacyCommand = `/${"workflow"}`

test("v1 declares exactly the supported Windows and Linux native packages", () => {
  const expected = [
    "@opencode-cycle/native-linux-x64",
    "@opencode-cycle/native-win32-x64",
  ] as const
  expect(NATIVE_PACKAGE_NAMES).toEqual(expected)
  expect(SHIPPED_NATIVE_PACKAGE_NAMES).toEqual(expected)
  expect(JSON.stringify({ NATIVE_PACKAGE_NAMES, SHIPPED_NATIVE_PACKAGE_NAMES })).not.toContain("darwin")
})

test(
  "repository surfaces contain no retired product identity outside reviewed compatibility",
  async () => {
    expect(await auditProductIdentity(process.cwd(), { requireApprovedPaths: true })).toEqual([])
  },
  10_000,
)

async function fixture(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "product-identity-"))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content, "utf8")
  }
  return root
}

function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
}

function utf16be(text: string): Buffer {
  const littleEndian = Buffer.from(text, "utf16le")
  for (let index = 0; index < littleEndian.length; index += 2) {
    const byte = littleEndian[index] ?? 0
    littleEndian[index] = littleEndian[index + 1] ?? 0
    littleEndian[index + 1] = byte
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), littleEndian])
}

test("identity audit catches retired runtime and export prefixes", async () => {
  const root = await fixture({
    "crates/workflowd/src/runtime.rs": `join("${legacyPackage}-delivery")`,
    "packages/opencode-cycle/src/index.ts": `export const ${legacyPluginExport} = () => ({})`,
  })
  try {
    expect(await auditProductIdentity(root)).toEqual([
      `crates/workflowd/src/runtime.rs: ${legacyPackage}`,
      `packages/opencode-cycle/src/index.ts: ${legacyPluginExport}`,
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("identity audit returns sorted findings from a multi-file batch", async () => {
  const root = await fixture(
    Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `docs/${String(23 - index).padStart(2, "0")}.md`,
        `${legacyProduct} ${index}`,
      ]),
    ),
  )
  const expected = Array.from(
    { length: 24 },
    (_, index) => `docs/${String(index).padStart(2, "0")}.md: ${legacyProduct}`,
  )
  try {
    expect(await Promise.all(Array.from({ length: 3 }, () => auditProductIdentity(root)))).toEqual([
      expected,
      expected,
      expected,
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("identity audit allows a reviewed durable domain only in its exact context", async () => {
  const root = await fixture({
    "crates/workflow-core/src/candidate.rs": `${legacyPackage}/candidate/v1`,
  })
  try {
    expect(await auditProductIdentity(root)).toEqual([])
    await writeFile(join(root, "crates/workflow-core/src/candidate.rs"), `${legacyPackage}/other/v1`, "utf8")
    expect(await auditProductIdentity(root)).toEqual([
      `crates/workflow-core/src/candidate.rs: approved ${legacyPackage}/candidate/v1 count is 0, expected 1`,
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("identity audit preserves valid workflow crate paths while rejecting the retired command", async () => {
  const root = await fixture({
    "docs/command-boundaries.md": `legacy ${legacyCommand} command; daemon /workflowd; .github/workflows`,
  })
  try {
    expect(await auditProductIdentity(root)).toEqual([`docs/command-boundaries.md: ${legacyCommand}`])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("identity audit detects retired identity encoded as UTF-16 text", async () => {
  const root = await fixture({
    "docs/legacy-le.md": utf16le(legacyPackage),
    "README.md": utf16be(legacyProduct),
  })
  try {
    expect(await auditProductIdentity(root)).toEqual([
      `README.md: ${legacyProduct}`,
      `docs/legacy-le.md: ${legacyPackage}`,
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("identity audit fails closed for invalid or BOM-less NUL text candidates", async () => {
  const root = await fixture({
    "README.md": Buffer.from([0xc3, 0x28]),
    "docs/nul.txt": Buffer.from([0x6f, 0, 0x6b]),
  })
  try {
    expect(await auditProductIdentity(root)).toEqual([
      "README.md: unsupported text encoding",
      "docs/nul.txt: unsupported text encoding",
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("identity audit skips known binary files and accepts normal Unicode text", async () => {
  const root = await fixture({
    "assets/logo.png": Buffer.from([0, 0xff, 0xd8]),
    "docs/unicode.md": "Cycle documentation: café 東京",
  })
  try {
    expect(await auditProductIdentity(root)).toEqual([])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("identity audit excludes only the exact vendored third-party schema paths", async () => {
  const root = await fixture({
    "scripts/release/schema/bom-1.6.schema.json": `third-party ${legacyCommand}`,
    "scripts/release/schema/not-vendored.schema.json": `unreviewed ${legacyCommand}`,
  })
  try {
    await expect(auditProductIdentity(root)).resolves.toEqual([
      `scripts/release/schema/not-vendored.schema.json: ${legacyCommand}`,
    ])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
