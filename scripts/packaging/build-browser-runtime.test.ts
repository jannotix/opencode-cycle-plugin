import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

test("browser runtime bundle excludes the unrelated Puppeteer CLI loader graph", async () => {
  const root = resolve(import.meta.dir, "../..")
  const pluginManifest = JSON.parse(await readFile(
    resolve(root, "packages", "opencode-cycle", "package.json"),
    "utf8",
  )) as { readonly dependencies?: Readonly<Record<string, string>> }
  const browsersManifest = JSON.parse(await readFile(
    resolve(root, "node_modules", ".bun", "@puppeteer+browsers@3.2.0", "node_modules", "@puppeteer", "browsers", "package.json"),
    "utf8",
  )) as {
    readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
    readonly version?: string
  }
  expect(pluginManifest.dependencies?.["@puppeteer/browsers"]).toBe("3.2.0")
  expect(browsersManifest).toMatchObject({
    peerDependenciesMeta: { "proxy-agent": { optional: true } },
    version: "3.2.0",
  })
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "build-browser-runtime.ts"),
  ], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "" })

  const bundle = await readFile(
    resolve(root, "packages", "opencode-cycle", "dist", "browser", "managed-browser-session.cjs"),
    "utf8",
  )
  const wrapper = await readFile(
    resolve(root, "packages", "opencode-cycle", "dist", "browser", "managed-browser-session.js"),
    "utf8",
  )
  expect(bundle).not.toContain("createRequire")
  expect(bundle).not.toContain("yargs")
  expect(bundle).not.toContain('import("proxy-agent")')
  expect(bundle).toContain('require("@puppeteer/browsers/lib/launch.js")')
  expect(wrapper).toBe([
    'import runtime from "./managed-browser-session.cjs"',
    "export const { ManagedBrowserSessionFactory } = runtime",
    "",
  ].join("\n"))
  const node = Bun.which("node")
  expect(node).toBeString()
  const moduleUrl = pathToFileURL(resolve(
      root,
      "packages",
      "opencode-cycle",
      "dist",
      "browser",
      "managed-browser-session.js",
    )).href
  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) =>
      value !== undefined && !["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"].includes(name.toUpperCase())),
  )
  for (const environment of [
    baseEnvironment,
    {
      ...baseEnvironment,
      ALL_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
    },
  ]) {
    const imported = Bun.spawn([
      node as string,
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(moduleUrl)}).then((value)=>{new value.ManagedBrowserSessionFactory({headless:true,projectDirectory:process.cwd()})})`,
    ], { env: environment, stderr: "pipe", stdout: "pipe", windowsHide: true })
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
  }
}, { timeout: 30_000 })
