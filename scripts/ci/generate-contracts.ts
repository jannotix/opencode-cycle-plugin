import { compile } from "json-schema-to-typescript"
import { fileURLToPath } from "node:url"

const rootUrl = new URL("../../", import.meta.url)
const root = fileURLToPath(rootUrl)
const schemaPath = new URL("packages/protocol-contracts/schema/protocol-envelope.schema.json", rootUrl)
const typesPath = new URL("packages/protocol-contracts/src/generated.ts", rootUrl)
const schemaModulePath = new URL("packages/protocol-contracts/src/generated-schema.ts", rootUrl)

const process = Bun.spawn(
  ["cargo", "run", "--quiet", "-p", "workflow-core", "--example", "export_schema", "--features", "schema"],
  { cwd: root, stderr: "inherit", stdout: "pipe" },
)
const output = await new Response(process.stdout).text()
if ((await process.exited) !== 0) throw new Error("Rust schema generation failed")

const schema = JSON.parse(output) as Record<string, unknown>
removeNonStandardNumericFormats(schema)
const schemaText = `${JSON.stringify(schema, null, 2)}\n`
const types = await compile(schema, "ProtocolEnvelope", {
  bannerComment: "",
  style: { semi: false, singleQuote: false, tabWidth: 2, trailingComma: "all" },
})
const schemaModule = `export const protocolSchema = ${JSON.stringify(schema, null, 2)} as const\n`

await Promise.all([
  writeIfChanged(schemaPath, schemaText),
  writeIfChanged(typesPath, types),
  writeIfChanged(schemaModulePath, schemaModule),
])

async function writeIfChanged(path: URL, content: string) {
  const file = Bun.file(path)
  if ((await file.exists()) && (await file.text()) === content) return
  await Bun.write(path, content)
}

function removeNonStandardNumericFormats(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) removeNonStandardNumericFormats(item)
    return
  }
  if (!value || typeof value !== "object") return
  const object = value as Record<string, unknown>
  const types = Array.isArray(object.type) ? object.type : [object.type]
  if (types.includes("integer") && typeof object.format === "string" && /^(u?int)(16|32|64)$/.test(object.format)) {
    delete object.format
  }
  for (const item of Object.values(object)) removeNonStandardNumericFormats(item)
}
