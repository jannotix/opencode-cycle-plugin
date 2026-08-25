import { readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const packageRoot = resolve(root, "packages", "opencode-cycle")
const entrypoint = resolve(packageRoot, "src", "browser", "managed-browser-session.ts")
const browsersFacade = resolve(
  packageRoot,
  "src",
  "browser",
  "puppeteer-browsers-runtime.js",
)
const output = resolve(packageRoot, "dist", "browser", "managed-browser-session.cjs")
const wrapper = resolve(packageRoot, "dist", "browser", "managed-browser-session.js")

const javaScriptSources = (await readdir(resolve(packageRoot, "src"), { recursive: true }))
  .map((path) => path.replaceAll("\\", "/"))
  .filter((path) => path.endsWith(".js"))
  .sort()
if (JSON.stringify(javaScriptSources) !== JSON.stringify([
  "browser/puppeteer-browsers-runtime.js",
  "browser/puppeteer-runtime.js",
])) throw new Error("Browser runtime JavaScript source allowlist changed")

const puppeteerRoot = await realpath(resolve(root, "node_modules", "puppeteer-core"))
const browsersRoot = resolve(dirname(puppeteerRoot), "@puppeteer", "browsers")
const [puppeteerManifest, browsersManifest] = await Promise.all([
  readManifest(resolve(puppeteerRoot, "package.json")),
  readManifest(resolve(browsersRoot, "package.json")),
])
if (
  puppeteerManifest.version !== "25.6.0" ||
  puppeteerManifest.dependencies?.["@puppeteer/browsers"] !== "3.2.0" ||
  browsersManifest.version !== "3.2.0"
) {
  throw new Error("Pinned browser runtime dependency versions changed")
}

const build = await Bun.build({
  entrypoints: [entrypoint],
  format: "cjs",
  packages: "bundle",
  plugins: [{
    name: "contained-puppeteer-browsers-runtime",
    setup(builder) {
      builder.onResolve({ filter: /^@puppeteer\/browsers$/u }, () => ({ path: browsersFacade }))
      builder.onResolve(
        { filter: /^@puppeteer\/browsers\/lib\//u },
        (arguments_) => ({ external: true, path: arguments_.path }),
      )
    },
  }],
  sourcemap: "none",
  target: "node",
})
if (!build.success || build.outputs.length !== 1) {
  throw new Error(`Browser runtime bundle failed: ${build.logs.map((log) => log.message).join("; ")}`)
}
const bundle = Buffer.from(await build.outputs[0]!.arrayBuffer())
if (bundle.byteLength < 1 || bundle.byteLength > 16 * 1024 * 1024) {
  throw new Error("Browser runtime bundle size is outside its production bound")
}
const bundleText = bundle.toString("utf8")
if (bundleText.includes("createRequire") || bundleText.includes("yargs")) {
  throw new Error("Browser runtime bundle contains a generated module loader")
}
await Promise.all([
  writeFile(output, bundle),
  writeFile(
    wrapper,
    [
      'import runtime from "./managed-browser-session.cjs"',
      "export const { ManagedBrowserSessionFactory } = runtime",
      "",
    ].join("\n"),
    "utf8",
  ),
])

async function readManifest(path: string): Promise<{
  readonly dependencies?: Readonly<Record<string, unknown>>
  readonly version?: unknown
}> {
  return JSON.parse(await readFile(path, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, unknown>>
    readonly version?: unknown
  }
}
