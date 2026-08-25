import { readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { TRUSTED_BROWSER_RUNTIME_BOUNDARY_HEADER } from "./browser-runtime-boundary.js"
import {
  rewriteTrustedBrowserBundleLiteralImports,
  trustedBrowserBundleModuleSpecifiers,
} from "./browser-runtime-boundary-proof.js"
import {
  browserRuntimeClientSource,
  browserRuntimeWorkerSource,
} from "./browser-runtime-worker-source.js"

const root = resolve(import.meta.dir, "../..")
const packageRoot = resolve(root, "packages", "opencode-cycle")
const entrypoint = resolve(packageRoot, "src", "browser", "managed-browser-session.ts")
const browsersFacade = resolve(
  packageRoot,
  "src",
  "browser",
  "puppeteer-browsers-runtime.js",
)
const legacyOutput = resolve(packageRoot, "dist", "browser", "managed-browser-session.cjs")
const worker = resolve(packageRoot, "dist", "browser", "managed-browser-worker.mjs")
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
const rawBundle = Buffer.from(await build.outputs[0]!.arrayBuffer())
const bundleText = rewriteTrustedBrowserBundleLiteralImports(rawBundle.toString("utf8"))
if (Buffer.byteLength(bundleText) < 1 || Buffer.byteLength(bundleText) > 16 * 1024 * 1024) {
  throw new Error("Browser runtime bundle size is outside its production bound")
}
if (bundleText.includes("createRequire") || bundleText.includes("yargs")) {
  throw new Error("Browser runtime bundle contains a generated module loader")
}
const specifiers = trustedBrowserBundleModuleSpecifiers(bundleText)
const workerSource = browserRuntimeWorkerSource(bundleText, specifiers)
const wrapperSource = browserRuntimeClientSource()
if (!workerSource.startsWith(TRUSTED_BROWSER_RUNTIME_BOUNDARY_HEADER) ||
  Buffer.byteLength(workerSource) > 20 * 1024 * 1024 || Buffer.byteLength(wrapperSource) > 64 * 1024) {
  throw new Error("Browser runtime isolated boundary is invalid")
}
await Promise.all([
  rm(legacyOutput, { force: true }),
  writeFile(worker, workerSource, "utf8"),
  writeFile(wrapper, wrapperSource, "utf8"),
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
