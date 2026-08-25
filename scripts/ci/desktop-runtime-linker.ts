export interface DesktopRuntimeLinkerExpected {
  readonly authoritative: boolean
  readonly candidateEntry: string
  readonly candidateEntrySha256: string
  readonly dependencyTreeSha256: string
  readonly electronVersion: string | null
  readonly installedPlugin: string
  readonly nodeVersion: string
  readonly resultFile: string
  readonly runtimeExecutableSha256: string
  readonly runtimeProductVersion: string
}

export function desktopRuntimeLinkerSource(expected: DesktopRuntimeLinkerExpected): string {
  return `import { createHash } from "node:crypto"
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs"
import { builtinModules, createRequire } from "node:module"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Script, SourceTextModule, SyntheticModule } from "node:vm"

const expected = ${JSON.stringify(expected)}
const digestBytes = (value) => createHash("sha256").update(value).digest("hex")
const digestFile = (path) => digestBytes(readFileSync(path))
const inside = (path) => {
  const value = relative(expected.installedPlugin, resolve(path))
  return value === "" || (value !== ".." && !value.startsWith(".." + sep))
}
if (
  typeof SourceTextModule !== "function" || typeof SyntheticModule !== "function" ||
  !isAbsolute(expected.installedPlugin) || resolve(expected.installedPlugin) !== expected.installedPlugin ||
  realpathSync(expected.installedPlugin) !== expected.installedPlugin ||
  !inside(expected.candidateEntry) || realpathSync(expected.candidateEntry) !== expected.candidateEntry ||
  process.versions.node !== expected.nodeVersion ||
  (expected.authoritative && process.versions.electron !== expected.electronVersion) ||
  (!expected.authoritative && expected.electronVersion !== null) ||
  digestFile(process.execPath) !== expected.runtimeExecutableSha256 ||
  digestFile(expected.candidateEntry) !== expected.candidateEntrySha256
) throw new Error("module linker runtime binding")
const manifest = JSON.parse(readFileSync(resolve(expected.installedPlugin, "package.json"), "utf8"))
if (manifest?.exports?.["."] !== "./dist/index.js") throw new Error("module linker candidate export")

const modules = new Map()
const graphFiles = new Map()
const builtins = new Set(builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name : "node:" + name]))
const dynamicEdges = []
const requireCall = /\\brequire\\s*\\(/gu
const literalRequire = /\\brequire\\s*\\(\\s*(["'])([^"']+)\\1\\s*\\)/gu

const collectDynamicImports = (text, parent) => {
  const callPattern = /\\bimport\\s*\\(/gu
  const literalPattern = /\\bimport\\s*\\(\\s*(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)?(["'])([^"'\\\\]+)\\1\\s*\\)/gu
  const covered = []
  for (const match of text.matchAll(literalPattern)) {
    dynamicEdges.push({ parent, specifier: match[2] })
    covered.push([match.index, match.index + match[0].length])
  }
  for (const match of text.matchAll(callPattern)) {
    if (!covered.some(([start, end]) => match.index >= start && match.index < end)) {
      throw new Error("unsafe dynamic import is forbidden")
    }
  }
}

const recordFile = (path, kind, source) => {
  const canonical = realpathSync(path)
  if (canonical !== resolve(path) || !inside(canonical) || !statSync(canonical).isFile()) {
    throw new Error("module linker path escape")
  }
  const sha256 = digestBytes(source)
  const previous = graphFiles.get(canonical)
  if (previous && previous.sha256 !== sha256) throw new Error("module linker file changed")
  graphFiles.set(canonical, { kind, sha256 })
  return canonical
}
const resolveImport = (specifier, parent, commonjs) => {
  if (specifier === "bun" || specifier.startsWith("bun:")) throw new Error("Bun builtin is forbidden")
  if (builtins.has(specifier)) return specifier.startsWith("node:") ? specifier : "node:" + specifier
  let resolved
  try {
    resolved = commonjs
      ? createRequire(pathToFileURL(parent)).resolve(specifier)
      : import.meta.resolve(specifier, pathToFileURL(parent).href)
  } catch {
    throw new Error(
      expected.authoritative
        ? "module linker unresolved import"
        : "module linker unresolved import " + specifier,
    )
  }
  if (typeof resolved !== "string") throw new Error("module linker unresolved import")
  const path = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved
  if (!isAbsolute(path) || !inside(path)) throw new Error("module linker dependency escape")
  return path
}
const packageManifestFor = (path) => {
  let cursor = dirname(path)
  for (;;) {
    const manifestPath = resolve(cursor, "package.json")
    try {
      return JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch {}
    if (cursor === expected.installedPlugin) return manifest
    const parent = dirname(cursor)
    if (parent === cursor || !inside(parent)) return {}
    cursor = parent
  }
}
const packageIsModule = (path) => packageManifestFor(path)?.type === "module"
const optionalPackageDependency = (path, specifier) => {
  const metadata = packageManifestFor(path)
  const segments = specifier.split("/")
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
  return Object.hasOwn(metadata?.optionalDependencies ?? {}, name) ||
    metadata?.peerDependenciesMeta?.[name]?.optional === true
}
const moduleKind = (path) => {
  const extension = extname(path).toLowerCase()
  if (extension === ".mjs") return "esm"
  if (extension === ".cjs") return "commonjs"
  if (extension === ".json") return "json"
  if (extension !== ".js") throw new Error("module linker unsupported module type")
  return packageIsModule(path) ? "esm" : "commonjs"
}
const builtinModule = async (specifier) => {
  const identifier = specifier.startsWith("node:") ? specifier : "node:" + specifier
  if (modules.has(identifier)) return modules.get(identifier)
  const namespace = await import(identifier)
  const names = [...new Set([...Object.keys(namespace), "default"])]
  const module = new SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, name === "default" ? namespace.default ?? namespace : namespace[name])
  }, { identifier })
  modules.set(identifier, module)
  return module
}
const jsonModule = (path) => {
  const canonical = realpathSync(path)
  if (modules.has(canonical)) return modules.get(canonical)
  const source = readFileSync(canonical)
  JSON.parse(source.toString("utf8"))
  recordFile(canonical, "json", source)
  const module = new SyntheticModule(["default"], function () {}, {
    identifier: pathToFileURL(canonical).href,
  })
  modules.set(canonical, module)
  return module
}
const commonJsModule = async (path) => {
  const canonical = realpathSync(path)
  if (modules.has(canonical)) return modules.get(canonical)
  const source = readFileSync(canonical)
  const text = source.toString("utf8")
  collectDynamicImports(text, canonical)
  new Script("(function(exports,require,module,__filename,__dirname){\\n" + text + "\\n})", {
    filename: canonical,
  })
  recordFile(canonical, "commonjs", source)
  const specifiers = []
  const covered = []
  for (const match of text.matchAll(literalRequire)) {
    specifiers.push(match[2])
    covered.push([match.index, match.index + match[0].length])
  }
  for (const match of text.matchAll(requireCall)) {
    if (!covered.some(([start, end]) => match.index >= start && match.index < end)) {
      throw new Error("dynamic require is forbidden")
    }
  }
  const names = new Set(["default"])
  for (const pattern of [/\\bexports\\.([A-Za-z_$][\\w$]*)/gu, /\\bmodule\\.exports\\.([A-Za-z_$][\\w$]*)/gu]) {
    for (const match of text.matchAll(pattern)) names.add(match[1])
  }
  const module = new SyntheticModule([...names], function () {}, {
    identifier: pathToFileURL(canonical).href,
  })
  modules.set(canonical, module)
  for (const specifier of specifiers) {
    let target
    try {
      target = resolveImport(specifier, canonical, true)
    } catch (error) {
      if (optionalPackageDependency(canonical, specifier)) continue
      throw error
    }
    if (!target.startsWith("node:")) await loadModule(target)
  }
  return module
}
const esmModule = (path) => {
  const canonical = realpathSync(path)
  if (modules.has(canonical)) return modules.get(canonical)
  const source = readFileSync(canonical)
  const text = source.toString("utf8")
  collectDynamicImports(text, canonical)
  recordFile(canonical, "esm", source)
  const module = new SourceTextModule(text, {
    identifier: pathToFileURL(canonical).href,
    importModuleDynamically() { throw new Error("dynamic import is forbidden") },
    initializeImportMeta(meta) { meta.url = pathToFileURL(canonical).href },
  })
  modules.set(canonical, module)
  return module
}
async function loadModule(path) {
  const kind = moduleKind(path)
  if (kind === "json") return jsonModule(path)
  if (kind === "commonjs") return commonJsModule(path)
  return esmModule(path)
}
const entry = await loadModule(expected.candidateEntry)
const linker = async (specifier, referencingModule) => {
  const parent = fileURLToPath(referencingModule.identifier)
  const target = resolveImport(specifier, parent, false)
  if (target.startsWith("node:")) return builtinModule(target)
  return loadModule(target)
}
await entry.link(linker)
if (
  Reflect.ownKeys(entry.namespace).filter((name) => typeof name === "string").sort().join(",") !==
    "default"
) {
  throw new Error("module linker candidate export surface")
}
for (let index = 0; index < dynamicEdges.length; index += 1) {
  const edge = dynamicEdges[index]
  let resolved
  try {
    resolved = resolveImport(edge.specifier, edge.parent, false)
  } catch (error) {
    if (optionalPackageDependency(edge.parent, edge.specifier)) continue
    throw error
  }
  const target = resolved.startsWith("node:")
    ? await builtinModule(resolved)
    : await loadModule(resolved)
  if (target.status === "unlinked") await target.link(linker)
}
if (digestFile(expected.candidateEntry) !== expected.candidateEntrySha256) {
  throw new Error("module linker candidate changed")
}
const graphCanonical = [...graphFiles.entries()]
  .map(([path, value]) => relative(expected.installedPlugin, path).split(sep).join("/") + "\\0" + value.kind + "\\0" + value.sha256 + "\\n")
  .sort()
  .join("")
const receipt = {
  candidateDefaultExportLinked: true,
  candidateEntrySha256: expected.candidateEntrySha256,
  candidateEvaluated: false,
  dependencyTreeSha256: expected.dependencyTreeSha256,
  unsafeDynamicImportsRejected: true,
  electronVersion: process.versions.electron ?? null,
  graphFileCount: graphFiles.size,
  graphSha256: digestBytes(graphCanonical),
  linkedModuleCount: modules.size,
  nodeVersion: process.versions.node,
  runtimeExecutableSha256: digestFile(process.execPath),
  runtimeProductVersion: expected.runtimeProductVersion,
  schemaVersion: 1,
  type: "opencode-cycle-desktop-module-link",
}
const result = openSync(expected.resultFile, "wx", 0o600)
try {
  writeSync(result, JSON.stringify(receipt) + "\\n", undefined, "utf8")
  fsyncSync(result)
} finally {
  closeSync(result)
}
`
}
