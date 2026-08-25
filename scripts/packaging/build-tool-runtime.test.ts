import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

test("tool runtime disables Zod code generation and imports under Desktop Node", async () => {
  const root = resolve(import.meta.dir, "../..")
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "build-tool-runtime.ts"),
  ], { cwd: root, stderr: "pipe", stdout: "pipe", windowsHide: true })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "" })
  const output = resolve(root, "packages", "opencode-cycle", "dist", "tool-runtime.js")
  const source = await readFile(output, "utf8")
  expect(source).not.toContain("const F = Function")
  expect(source).not.toContain("new Function")
  expect(source).not.toContain("createRequire")
  expect(source).not.toContain('from "zod"')

  const node = Bun.which("node")
  expect(node).toBeString()
  const moduleUrl = pathToFileURL(output).href
  const imported = Bun.spawn([
    node as string,
    "--input-type=module",
    "-e",
    [
      `import(${JSON.stringify(moduleUrl)}).then(({tool})=>{`,
      "const definition=tool({description:'test',args:{value:tool.schema.string().min(1)},async execute(){return 'ok'}});",
      "if(!definition.args.value.safeParse('value').success)process.exit(2);",
      "})",
    ].join(""),
  ], { stderr: "pipe", stdout: "pipe", windowsHide: true })
  const [importExit, importStdout, importStderr] = await Promise.all([
    imported.exited,
    new Response(imported.stdout).text(),
    new Response(imported.stderr).text(),
  ])
  expect({ importExit, importStderr, importStdout }).toEqual({
    importExit: 0,
    importStderr: "",
    importStdout: "",
  })
}, { timeout: 30_000 })
