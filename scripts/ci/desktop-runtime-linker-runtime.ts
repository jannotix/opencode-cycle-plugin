import { parse } from "acorn"
import { createHash } from "node:crypto"
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { SourceTextModule, SyntheticModule, type Module } from "node:vm"

import type { DesktopRuntimeLinkerExpected } from "./desktop-runtime-linker.js"
import { DESKTOP_LINKER_INPUT_MAGIC } from "./desktop-dependency-tree.js"
import {
  TRUSTED_BROWSER_RUNTIME_BOUNDARY_PATH,
} from "../packaging/browser-runtime-boundary.js"

type ModuleKind = "asset" | "commonjs" | "esm" | "json"
type EdgeKind = "dynamic" | "require" | "resolve" | "static"

interface AstNode {
  readonly [key: string]: unknown
  readonly type: string
}

interface GraphEdge {
  readonly importedNames: ReadonlySet<string>
  readonly kind: EdgeKind
  readonly parent: string
  readonly specifier: string
  suppressedOptionalRoot?: boolean
  target?: string
}

interface GraphNode {
  readonly bytes: Buffer
  readonly commonJsExports: Set<string>
  readonly edges: GraphEdge[]
  readonly kind: ModuleKind
  readonly path: string
  readonly sha256: string
  readonly trustedBundledBoundary: boolean
}

interface HeldFile {
  readonly bytes: Buffer
  readonly contentAvailable: boolean
  readonly path: string
  readonly relativePath: string
  readonly sha256: string
  readonly size: number
}

interface PackageManifest {
  readonly exports?: unknown
  readonly imports?: unknown
  readonly main?: unknown
  readonly name?: unknown
  readonly optionalDependencies?: unknown
  readonly peerDependenciesMeta?: unknown
  readonly type?: unknown
}

type ResolutionCode =
  | "FORBIDDEN"
  | "INVALID_SPECIFIER"
  | "MODULE_NOT_FOUND_ROOT"
  | "MODULE_NOT_FOUND_TARGET"

class ResolutionError extends Error {
  constructor(readonly code: ResolutionCode) {
    super(code)
  }
}

const GENERATED_LOADING_BUILTINS = new Set(["module", "node:module", "node:vm", "vm"])
const MAX_GRAPH_FILES = 50_000
const MAX_MODULE_BYTES = 64 * 1024 * 1024
const MAX_RUNTIME_INPUT_BYTES = 64 * 1024 * 1024
const MAX_RUNTIME_INPUT_FILES = 10_000

export async function runDesktopRuntimeLinker(
  expected: DesktopRuntimeLinkerExpected,
): Promise<void> {
  const digestBytes = (value: Uint8Array | string): string =>
    createHash("sha256").update(value).digest("hex")
  const digestFile = (path: string): string => digestBytes(readFileSync(path))
  const root = resolve(expected.installedPlugin)
  const canonicalKey = (path: string): string => {
    const absolute = resolve(path)
    return process.platform === "win32" ? absolute.toLowerCase() : absolute
  }
  const inside = (path: string): boolean => {
    const value = relative(root, resolve(path))
    return value === "" || (value !== ".." && !value.startsWith(`..${sep}`))
  }

  // Every rejection reason is a fixed code, never a value: the message reaches an
  // operator through captured runtime output, so it must say which expectation
  // broke without disclosing paths, digests, or counts.
  const bindingFailure = ((): string | undefined => {
    if (typeof SourceTextModule !== "function" || typeof SyntheticModule !== "function") {
      return "vm_modules_unavailable"
    }
    if (!isAbsolute(root) || root !== expected.installedPlugin) return "installed_plugin_path"
    if (!isAbsolute(expected.candidateEntry) || !inside(expected.candidateEntry)) {
      return "candidate_entry_path"
    }
    if (!Number.isSafeInteger(expected.fullTreeFileCount) || expected.fullTreeFileCount < 1) {
      return "full_tree_file_count"
    }
    if (
      !Number.isSafeInteger(expected.runtimeInputFileCount) || expected.runtimeInputFileCount < 1 ||
      expected.runtimeInputFileCount > MAX_RUNTIME_INPUT_FILES ||
      expected.runtimeInputFileCount > expected.fullTreeFileCount
    ) return "runtime_input_file_count"
    if (
      !Number.isSafeInteger(expected.runtimeInputContentBytes) ||
      expected.runtimeInputContentBytes < 1
    ) return "runtime_input_content_bytes"
    if (
      !Number.isSafeInteger(expected.runtimeInputSerializedBytes) ||
      expected.runtimeInputSerializedBytes < expected.runtimeInputContentBytes ||
      expected.runtimeInputSerializedBytes > MAX_RUNTIME_INPUT_BYTES
    ) return "runtime_input_serialized_bytes"
    if (!/^[0-9a-f]{64}$/u.test(expected.runtimeInputSha256)) return "runtime_input_digest_format"
    if (process.versions.node !== expected.nodeVersion) return "node_version"
    if (expected.authoritative && process.versions.electron !== expected.electronVersion) {
      return "electron_version"
    }
    if (!expected.authoritative && expected.electronVersion !== null) {
      return "electron_version_expectation"
    }
    if (digestFile(process.execPath) !== expected.runtimeExecutableSha256) {
      return "runtime_executable_digest"
    }
    return undefined
  })()
  if (bindingFailure !== undefined) {
    throw new Error(`module linker runtime binding: ${bindingFailure}`)
  }

  const heldFiles = readHeldFiles(root, expected, canonicalKey, inside)
  const candidate = heldFiles.get(canonicalKey(expected.candidateEntry))
  if (candidate === undefined || candidate.sha256 !== expected.candidateEntrySha256) {
    throw new Error("module linker candidate binding")
  }

  const graph = new Map<string, GraphNode>()
  const manifestCache = new Map<string, PackageManifest>()
  const builtins = new Set(
    builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name : `node:${name}`]),
  )

  const fileAt = (path: string): HeldFile | undefined => heldFiles.get(canonicalKey(path))
  const directoryExists = (path: string): boolean => {
    const prefix = `${canonicalKey(path)}${sep}`
    for (const key of heldFiles.keys()) if (key.startsWith(prefix)) return true
    return false
  }
  const readManifest = (path: string): PackageManifest => {
    const key = canonicalKey(path)
    const cached = manifestCache.get(key)
    if (cached !== undefined) return cached
    const file = fileAt(path)
    if (file === undefined || !file.contentAvailable) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    let value: unknown
    try {
      value = JSON.parse(file.bytes.toString("utf8")) as unknown
    } catch {
      throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    }
    if (!isRecord(value)) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    const manifest = value as PackageManifest
    manifestCache.set(key, manifest)
    return manifest
  }
  const packageManifestFor = (path: string): PackageManifest => {
    let cursor = dirname(path)
    for (;;) {
      const manifestPath = resolve(cursor, "package.json")
      if (fileAt(manifestPath) !== undefined) return readManifest(manifestPath)
      if (canonicalKey(cursor) === canonicalKey(root)) {
        throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      }
      const parent = dirname(cursor)
      if (parent === cursor || !inside(parent)) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      cursor = parent
    }
  }
  const packageIsModule = (path: string): boolean => packageManifestFor(path).type === "module"
  const moduleKind = (path: string): Exclude<ModuleKind, "asset"> => {
    const extension = extname(path).toLowerCase()
    if (extension === ".mjs") return "esm"
    if (extension === ".cjs") return "commonjs"
    if (extension === ".json") return "json"
    if (extension !== ".js" && extension !== "") {
      throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    }
    return packageIsModule(path) ? "esm" : "commonjs"
  }

  const resolveAsFile = (path: string, commonjs: boolean): string | undefined => {
    if (fileAt(path) !== undefined) return resolve(path)
    if (!commonjs) return undefined
    for (const extension of [".js", ".json", ".node"]) {
      const candidatePath = `${path}${extension}`
      if (fileAt(candidatePath) !== undefined) return resolve(candidatePath)
    }
    return undefined
  }
  const resolveAsDirectory = (path: string, commonjs: boolean): string | undefined => {
    if (!directoryExists(path)) return undefined
    const manifestPath = resolve(path, "package.json")
    if (fileAt(manifestPath) !== undefined) {
      const metadata = readManifest(manifestPath)
      if (typeof metadata.main === "string" && metadata.main.length > 0) {
        const main = resolve(path, metadata.main)
        if (!inside(main)) throw new ResolutionError("FORBIDDEN")
        const target = resolveAsFile(main, commonjs) ?? resolveAsDirectory(main, commonjs)
        if (target !== undefined) return target
      }
    }
    if (commonjs) {
      return resolveAsFile(resolve(path, "index"), true)
    }
    return undefined
  }
  const resolvePath = (path: string, commonjs: boolean): string => {
    const absolute = resolve(path)
    if (!inside(absolute)) throw new ResolutionError("FORBIDDEN")
    const target = resolveAsFile(absolute, commonjs) ?? resolveAsDirectory(absolute, commonjs)
    if (target === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    return target
  }

  const packageParts = (specifier: string): { name: string; subpath: string } => {
    if (
      specifier.length === 0 || specifier.includes("\\") || specifier.includes("\0") ||
      specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("%")
    ) throw new ResolutionError("INVALID_SPECIFIER")
    const segments = specifier.split("/")
    const name = specifier.startsWith("@")
      ? segments.length >= 2 ? segments.slice(0, 2).join("/") : ""
      : segments[0] ?? ""
    if (
      name === "" || name === "@" || name.includes("..") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) throw new ResolutionError("INVALID_SPECIFIER")
    const consumed = name.startsWith("@") ? 2 : 1
    return { name, subpath: segments.length === consumed ? "." : `./${segments.slice(consumed).join("/")}` }
  }
  const locatePackageRoot = (name: string, parent: string): string | undefined => {
    let cursor = dirname(parent)
    const segments = name.split("/")
    for (;;) {
      const candidateRoot = resolve(cursor, "node_modules", ...segments)
      if (directoryExists(candidateRoot)) return candidateRoot
      if (canonicalKey(cursor) === canonicalKey(root)) return undefined
      const next = dirname(cursor)
      if (next === cursor || !inside(next)) return undefined
      cursor = next
    }
  }
  const conditionsFor = (commonjs: boolean): ReadonlySet<string> =>
    new Set(["node", commonjs ? "require" : "import", "default"])
  const selectPackageTarget = (
    value: unknown,
    packageRoot: string,
    conditions: ReadonlySet<string>,
    replacement: string | undefined,
  ): string | undefined => {
    if (value === null) throw new ResolutionError("FORBIDDEN")
    if (typeof value === "string") {
      const target = replacement === undefined ? value : value.replaceAll("*", replacement)
      if (!target.startsWith("./") || target.split("/").some((part) => part === ".." || part === "node_modules")) {
        throw new ResolutionError("FORBIDDEN")
      }
      const resolved = resolve(packageRoot, target)
      if (!inside(resolved) || relative(packageRoot, resolved).startsWith(`..${sep}`)) {
        throw new ResolutionError("FORBIDDEN")
      }
      return resolved
    }
    if (Array.isArray(value)) {
      let missing = false
      for (const option of value) {
        try {
          const target = selectPackageTarget(option, packageRoot, conditions, replacement)
          if (target !== undefined) return target
        } catch (error) {
          if (!(error instanceof ResolutionError) || error.code !== "MODULE_NOT_FOUND_TARGET") throw error
          missing = true
        }
      }
      if (missing) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      return undefined
    }
    if (!isRecord(value)) throw new ResolutionError("INVALID_SPECIFIER")
    for (const [condition, target] of Object.entries(value)) {
      if (conditions.has(condition)) {
        const selected = selectPackageTarget(target, packageRoot, conditions, replacement)
        if (selected !== undefined) return selected
      }
    }
    return undefined
  }
  const selectSubpathTarget = (
    exportsValue: unknown,
    subpath: string,
    packageRoot: string,
    conditions: ReadonlySet<string>,
  ): string => {
    if (!isRecord(exportsValue) || Object.keys(exportsValue).every((key) => !key.startsWith("."))) {
      if (subpath !== ".") throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      const target = selectPackageTarget(exportsValue, packageRoot, conditions, undefined)
      if (target === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      return target
    }
    const keys = Object.keys(exportsValue)
    if (keys.some((key) => !key.startsWith("."))) throw new ResolutionError("INVALID_SPECIFIER")
    if (Object.hasOwn(exportsValue, subpath)) {
      const target = selectPackageTarget(exportsValue[subpath], packageRoot, conditions, undefined)
      if (target === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      return target
    }
    const patterns = keys
      .filter((key) => key.includes("*"))
      .map((key) => {
        const [prefix = "", suffix = ""] = key.split("*")
        return { key, prefix, suffix }
      })
      .filter(({ prefix, suffix }) => subpath.startsWith(prefix) && subpath.endsWith(suffix))
      .sort((left, right) => right.prefix.length - left.prefix.length || right.suffix.length - left.suffix.length)
    const pattern = patterns[0]
    if (pattern === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    const replacement = subpath.slice(pattern.prefix.length, subpath.length - pattern.suffix.length)
    const target = selectPackageTarget(
      exportsValue[pattern.key],
      packageRoot,
      conditions,
      replacement,
    )
    if (target === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    return target
  }
  const resolvePackage = (specifier: string, parent: string, commonjs: boolean): string => {
    const { name, subpath } = packageParts(specifier)
    const packageRoot = locatePackageRoot(name, parent)
    if (packageRoot === undefined) throw new ResolutionError("MODULE_NOT_FOUND_ROOT")
    const metadataPath = resolve(packageRoot, "package.json")
    if (fileAt(metadataPath) === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    const metadata = readManifest(metadataPath)
    let target: string
    if (metadata.exports !== undefined) {
      target = selectSubpathTarget(metadata.exports, subpath, packageRoot, conditionsFor(commonjs))
      if (fileAt(target) === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      return target
    }
    if (subpath !== ".") return resolvePath(resolve(packageRoot, subpath.slice(2)), commonjs)
    if (typeof metadata.main === "string" && metadata.main.length > 0) {
      return resolvePath(resolve(packageRoot, metadata.main), commonjs)
    }
    return resolvePath(resolve(packageRoot, "index"), commonjs)
  }
  const resolvePackageImport = (specifier: string, parent: string, commonjs: boolean): string => {
    const metadata = packageManifestFor(parent)
    if (!isRecord(metadata.imports)) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    const packageRoot = packageRootFor(parent, root, fileAt)
    const imports = metadata.imports
    if (Object.hasOwn(imports, specifier)) {
      const target = selectPackageTarget(imports[specifier], packageRoot, conditionsFor(commonjs), undefined)
      if (target === undefined || fileAt(target) === undefined) {
        throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
      }
      return target
    }
    const patterns = Object.keys(imports)
      .filter((key) => key.includes("*"))
      .map((key) => {
        const [prefix = "", suffix = ""] = key.split("*")
        return { key, prefix, suffix }
      })
      .filter(({ prefix, suffix }) => specifier.startsWith(prefix) && specifier.endsWith(suffix))
      .sort((left, right) => right.prefix.length - left.prefix.length)
    const pattern = patterns[0]
    if (pattern === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    const replacement = specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length)
    const target = selectPackageTarget(imports[pattern.key], packageRoot, conditionsFor(commonjs), replacement)
    if (target === undefined || fileAt(target) === undefined) {
      throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    }
    return target
  }
  const resolveEdge = (edge: GraphEdge): string => {
    const specifier = edge.specifier
    if (specifier === "bun" || specifier.startsWith("bun:")) {
      throw new ResolutionError("FORBIDDEN")
    }
    if (GENERATED_LOADING_BUILTINS.has(specifier)) throw new ResolutionError("FORBIDDEN")
    if (builtins.has(specifier)) return specifier.startsWith("node:") ? specifier : `node:${specifier}`
    const commonjs = edge.kind === "require"
    if (specifier.startsWith("file:")) return resolvePath(fileURLToPath(specifier), commonjs)
    if (specifier.startsWith("#")) return resolvePackageImport(specifier, edge.parent, commonjs)
    if (specifier.startsWith(".") || isAbsolute(specifier)) {
      return resolvePath(resolve(dirname(edge.parent), specifier), commonjs)
    }
    return resolvePackage(specifier, edge.parent, commonjs)
  }
  const optionalAbsentRoot = (edge: GraphEdge, error: unknown): boolean => {
    if (
      !(error instanceof ResolutionError) || error.code !== "MODULE_NOT_FOUND_ROOT" ||
      edge.kind === "static"
    ) return false
    let parts: { name: string; subpath: string }
    try {
      parts = packageParts(edge.specifier)
    } catch {
      return false
    }
    if (parts.subpath !== ".") return false
    const metadata = packageManifestFor(edge.parent)
    const optional = isRecord(metadata.optionalDependencies) &&
      Object.hasOwn(metadata.optionalDependencies, parts.name)
    const peerMetadata = isRecord(metadata.peerDependenciesMeta)
      ? metadata.peerDependenciesMeta[parts.name]
      : undefined
    const peerOptional = isRecord(peerMetadata) && peerMetadata.optional === true
    return optional || peerOptional
  }

  const collect = (path: string, resolutionOnly = false): GraphNode => {
    const absolute = resolve(path)
    const key = canonicalKey(absolute)
    const existing = graph.get(key)
    if (existing !== undefined) {
      if (resolutionOnly || existing.kind !== "asset") return existing
      graph.delete(key)
    }
    const held = fileAt(absolute)
    if (held === undefined) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    if (graph.size >= MAX_GRAPH_FILES) throw new Error("module linker graph exceeds its file limit")
    if (resolutionOnly) {
      const relativePath = relative(root, absolute).split(sep).join("/")
      const asset: GraphNode = {
        bytes: held.bytes,
        commonJsExports: new Set(),
        edges: [],
        kind: "asset",
        path: absolute,
        sha256: held.sha256,
        trustedBundledBoundary: relativePath === TRUSTED_BROWSER_RUNTIME_BOUNDARY_PATH,
      }
      graph.set(key, asset)
      return asset
    }
    if (!held.contentAvailable) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    const kind = moduleKind(absolute)
    if (held.bytes.byteLength > MAX_MODULE_BYTES) {
      throw new Error("module linker module exceeds its byte limit")
    }
    if (kind === "json") {
      try {
        JSON.parse(held.bytes.toString("utf8"))
      } catch {
        throw new Error("module linker JSON is malformed")
      }
      const json: GraphNode = {
        bytes: held.bytes,
        commonJsExports: new Set(),
        edges: [],
        kind,
        path: absolute,
        sha256: held.sha256,
        trustedBundledBoundary: false,
      }
      graph.set(key, json)
      return json
    }
    let analysis: ReturnType<typeof analyzeJavaScript>
    const source = held.bytes.toString("utf8")
    try {
      analysis = analyzeJavaScript(source, absolute, kind)
    } catch (error) {
      const message = error instanceof Error ? error.message : "module parse failed"
      throw new Error(`${message}: ${relative(root, absolute).split(sep).join("/")}`)
    }
    const node: GraphNode = {
      bytes: held.bytes,
      commonJsExports: analysis.commonJsExports,
      edges: analysis.edges,
      kind,
      path: absolute,
      sha256: held.sha256,
      trustedBundledBoundary: false,
    }
    graph.set(key, node)
    for (const edge of node.edges) {
      let target: string
      try {
        target = resolveEdge(edge)
      } catch (error) {
        if (optionalAbsentRoot(edge, error)) {
          edge.suppressedOptionalRoot = true
          continue
        }
        throw error
      }
      edge.target = target
      if (target.startsWith("node:")) continue
      collect(target, edge.kind === "resolve")
    }
    return node
  }

  const entryNode = collect(expected.candidateEntry)
  if (entryNode.kind !== "esm") throw new Error("module linker candidate must be ESM")

  const modules = new Map<string, SourceTextModule | SyntheticModule>()
  const requestedNames = new Map<string, Set<string>>()
  for (const node of graph.values()) {
    for (const edge of node.edges) {
      if (edge.target === undefined) continue
      const names = requestedNames.get(edge.target) ?? new Set<string>()
      for (const name of edge.importedNames) names.add(name)
      requestedNames.set(edge.target, names)
    }
  }
  for (const node of graph.values()) {
    if (node.kind === "asset") continue
    const identifier = pathToFileURL(node.path).href
    if (node.kind === "esm") {
      modules.set(canonicalKey(node.path), new SourceTextModule(node.bytes.toString("utf8"), {
        identifier,
        importModuleDynamically() { throw new Error("dynamic import evaluation is forbidden") },
        initializeImportMeta(meta) { meta.url = identifier },
      }))
      continue
    }
    const names = node.kind === "json"
      ? ["default"]
      : [...new Set([
          "default",
          ...node.commonJsExports,
          ...(requestedNames.get(node.path) ?? []),
        ])]
    modules.set(canonicalKey(node.path), new SyntheticModule(names, function () {}, { identifier }))
  }
  const builtinModule = async (specifier: string): Promise<SyntheticModule> => {
    const identifier = specifier.startsWith("node:") ? specifier : `node:${specifier}`
    const existing = modules.get(identifier)
    if (existing !== undefined) return existing as SyntheticModule
    const namespace = await import(identifier)
    const names = [...new Set([
      "default",
      ...Object.keys(namespace),
      ...(requestedNames.get(identifier) ?? []),
    ])]
    const module = new SyntheticModule(names, function () {}, { identifier })
    modules.set(identifier, module)
    return module
  }
  const linker = async (specifier: string, referencingModule: Module) => {
    if (!(referencingModule instanceof SourceTextModule)) {
      throw new Error("module linker reference is not ESM")
    }
    const parent = fileURLToPath(referencingModule.identifier)
    const parentNode = graph.get(canonicalKey(parent))
    const edge = parentNode?.edges.find((candidateEdge) =>
      candidateEdge.kind === "static" && candidateEdge.specifier === specifier &&
      candidateEdge.target !== undefined)
    if (edge?.target === undefined) throw new Error("module linker static edge is not verified")
    if (edge.target.startsWith("node:")) return builtinModule(edge.target)
    const target = modules.get(canonicalKey(edge.target))
    if (target === undefined) throw new Error("module linker target is not verified")
    return target
  }
  for (const module of modules.values()) {
    if (module instanceof SourceTextModule && module.status === "unlinked") await module.link(linker)
  }
  const entry = modules.get(canonicalKey(expected.candidateEntry))
  if (!(entry instanceof SourceTextModule) || entry.status !== "linked") {
    throw new Error("module linker candidate did not link")
  }
  if (
    Reflect.ownKeys(entry.namespace).filter((name) => typeof name === "string").sort().join(",") !==
      "default"
  ) throw new Error("module linker candidate export surface")

  const nodes = [...graph.values()]
  const linkedEsmModuleCount = nodes.filter((node) => node.kind === "esm").length
  if (
    [...modules.values()].filter((module) => module instanceof SourceTextModule && module.status === "linked")
      .length !== linkedEsmModuleCount
  ) throw new Error("module linker ESM count is inconsistent")
  const verifiedCommonJsModuleCount = nodes.filter((node) => node.kind === "commonjs").length
  const verifiedJsonModuleCount = nodes.filter((node) => node.kind === "json").length
  const verifiedAssetFileCount = nodes.filter((node) => node.kind === "asset").length
  const isolatedRuntimeBoundaries = nodes.filter((node) => node.trustedBundledBoundary)
  if (isolatedRuntimeBoundaries.length > 1) {
    throw new Error("module linker isolated runtime boundary count is invalid")
  }
  const isolatedRuntimeBoundary = isolatedRuntimeBoundaries[0]
  if (
    linkedEsmModuleCount + verifiedCommonJsModuleCount + verifiedJsonModuleCount +
      verifiedAssetFileCount !== graph.size
  ) throw new Error("module linker graph count is inconsistent")
  const graphCanonical = [
    ...nodes.map((node) =>
      `file\0${relative(root, node.path).split(sep).join("/")}\0${node.kind}\0${node.sha256}\n`),
    ...nodes.flatMap((node) => node.edges.map((edge) => {
      const target = edge.suppressedOptionalRoot
        ? "optional-absent"
        : edge.target?.startsWith("node:")
          ? edge.target
          : edge.target === undefined
            ? "unresolved"
            : relative(root, edge.target).split(sep).join("/")
      return `edge\0${relative(root, node.path).split(sep).join("/")}\0${edge.kind}\0${edge.specifier}\0${target}\n`
    })),
  ].sort().join("")
  const receipt = {
    candidateDefaultExportLinked: true,
    candidateEntrySha256: expected.candidateEntrySha256,
    candidateEvaluated: false,
    dependencyTreeSha256: expected.dependencyTreeSha256,
    electronVersion: process.versions.electron ?? null,
    fullTreeFileCount: expected.fullTreeFileCount,
    graphFileCount: graph.size,
    graphSha256: digestBytes(graphCanonical),
    isolatedRuntimeBoundaryCount: isolatedRuntimeBoundaries.length,
    isolatedRuntimeBoundarySha256: isolatedRuntimeBoundary?.sha256 ?? null,
    linkedEsmModuleCount,
    moduleLoadingProof: isolatedRuntimeBoundary === undefined
      ? "static-literal-plugin-host-v1"
      : "static-literal-plugin-host-with-isolated-worker-v1",
    nodeVersion: process.versions.node,
    runtimeInputContentBytes: expected.runtimeInputContentBytes,
    runtimeInputFileCount: expected.runtimeInputFileCount,
    runtimeInputSerializedBytes: expected.runtimeInputSerializedBytes,
    runtimeInputSha256: expected.runtimeInputSha256,
    runtimeExecutableSha256: digestFile(process.execPath),
    runtimeProductVersion: expected.runtimeProductVersion,
    schemaVersion: 4,
    suppressedOptionalRootCount: nodes.flatMap((node) => node.edges)
      .filter((edge) => edge.suppressedOptionalRoot).length,
    type: "opencode-cycle-desktop-module-link",
    unsafeDynamicImportsRejected: true,
    unverifiedPluginHostModuleLoadingRejected: true,
    verifiedAssetFileCount,
    verifiedCommonJsModuleCount,
    verifiedContentTreeSha256: expected.verifiedContentTreeSha256,
    verifiedJsonModuleCount,
  }
  const result = openSync(expected.resultFile, "wx", 0o600)
  try {
    writeSync(result, `${JSON.stringify(receipt)}\n`, undefined, "utf8")
    fsyncSync(result)
  } finally {
    closeSync(result)
  }
}

function readHeldFiles(
  root: string,
  expected: DesktopRuntimeLinkerExpected,
  canonicalKey: (path: string) => string,
  inside: (path: string) => boolean,
): Map<string, HeldFile> {
  const input = readFileSync(0)
  const magic = Buffer.from(DESKTOP_LINKER_INPUT_MAGIC, "utf8")
  if (input.byteLength < magic.byteLength + 4 || !input.subarray(0, magic.byteLength).equals(magic)) {
    throw new Error("module linker held input header")
  }
  let offset = magic.byteLength
  const count = input.readUInt32LE(offset)
  offset += 4
  if (
    count < 1 || count > MAX_GRAPH_FILES || count !== expected.runtimeInputFileCount ||
    input.byteLength !== expected.runtimeInputSerializedBytes
  ) throw new Error("module linker held input count")
  const files = new Map<string, HeldFile>()
  const records: string[] = []
  let totalContentBytes = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 53 > input.byteLength) throw new Error("module linker held input frame")
    const kindValue = input.readUInt8(offset)
    const nameBytes = input.readUInt32LE(offset + 1)
    const fileBytes = input.readBigUInt64LE(offset + 5)
    const contentBytes = input.readBigUInt64LE(offset + 13)
    const claimedSha256 = input.subarray(offset + 21, offset + 53).toString("hex")
    offset += 53
    if (
      ![1, 2].includes(kindValue) || nameBytes < 1 || nameBytes > 16 * 1024 ||
      fileBytes > BigInt(MAX_MODULE_BYTES) || contentBytes > fileBytes ||
      (kindValue === 1 && contentBytes !== fileBytes) ||
      (kindValue === 2 && contentBytes !== 0n)
    ) {
      throw new Error("module linker held input bound")
    }
    const endName = offset + nameBytes
    const endContent = endName + Number(contentBytes)
    if (endContent > input.byteLength) throw new Error("module linker held input truncated")
    const relativePath = input.subarray(offset, endName).toString("utf8")
    const segments = relativePath.split("/")
    if (
      relativePath.includes("\\") || relativePath.includes("\0") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) throw new Error("module linker held input path")
    const path = resolve(root, ...segments)
    if (!inside(path)) throw new Error("module linker held input escape")
    const bytes = input.subarray(endName, endContent)
    const contentAvailable = kindValue === 1
    if (contentAvailable && createHash("sha256").update(bytes).digest("hex") !== claimedSha256) {
      throw new Error("module linker held input content digest")
    }
    const key = canonicalKey(path)
    if (files.has(key)) throw new Error("module linker held input duplicate")
    files.set(key, {
      bytes,
      contentAvailable,
      path,
      relativePath,
      sha256: claimedSha256,
      size: Number(fileBytes),
    })
    const kind = contentAvailable ? "content" : "metadata"
    records.push(`${relativePath}\0${kind}\0${String(fileBytes)}\0${claimedSha256}\n`)
    totalContentBytes += Number(contentBytes)
    offset = endContent
  }
  if (offset !== input.byteLength || files.size !== count) throw new Error("module linker held input trailer")
  const runtimeInputSha256 = createHash("sha256").update(records.sort().join("")).digest("hex")
  if (
    runtimeInputSha256 !== expected.runtimeInputSha256 ||
    totalContentBytes !== expected.runtimeInputContentBytes ||
    expected.runtimeInputFileCount > expected.fullTreeFileCount
  ) throw new Error("module linker held input digest")
  return files
}

export function analyzeJavaScript(
  source: string,
  parent: string,
  kind: "commonjs" | "esm",
): { readonly commonJsExports: Set<string>; readonly edges: GraphEdge[] } {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: kind === "esm" ? "module" : "script",
  }) as unknown as AstNode
  const scopes = buildJavaScriptScopes(ast)
  const commonJsExports = new Set<string>()
  const edges: GraphEdge[] = []
  const addEdge = (
    edgeKind: EdgeKind,
    specifier: unknown,
    importedNames: Iterable<string> = [],
  ): void => {
    if (typeof specifier !== "string" || specifier.length === 0) {
      throw new Error("unsafe nonliteral module loading is forbidden")
    }
    edges.push({ importedNames: new Set(importedNames), kind: edgeKind, parent, specifier })
  }
  const visit = (node: AstNode, parentNode?: AstNode, parentKey?: string): void => {
    let skipCallee = false
    const scope = scopes.get(node)
    if (scope === undefined) throw new Error("module linker lexical scope is missing")
    if (node.type === "ImportDeclaration") {
      addEdge("static", literalString(node.source), importNames(node))
    } else if (node.type === "ExportNamedDeclaration" &&
      node.source !== null && node.source !== undefined) {
      addEdge("static", literalString(node.source), exportNames(node))
    } else if (node.type === "ExportAllDeclaration") {
      addEdge("static", literalString(node.source), ["*"])
    } else if (node.type === "ImportExpression") {
      addEdge("dynamic", literalString(node.source))
    } else if (node.type === "CallExpression") {
      const callee = asNode(node.callee)
      const argumentsList = Array.isArray(node.arguments) ? node.arguments : []
      if (callee?.type === "Identifier" && callee.name === "eval") {
        throw new Error("generated module loading is forbidden")
      }
      if (callee?.type === "Identifier" && callee.name === "Proxy") throw new Error("module loader proxy is forbidden")
      if (callee?.type === "Identifier" && callee.name === "require") {
        if (kind !== "commonjs" || argumentsList.length !== 1) {
          throw new Error("unsafe require is forbidden")
        }
        addEdge("require", literalString(argumentsList[0]))
        skipCallee = true
      } else if (isImportMetaResolve(callee)) {
        if (argumentsList.length !== 1) throw new Error("unsafe import.meta.resolve is forbidden")
        addEdge("resolve", literalString(argumentsList[0]))
        skipCallee = true
      } else if (forbiddenGeneratedCallee(callee)) {
        if (generatedSourceCouldLoadModules(argumentsList)) {
          throw new Error("generated module loading is forbidden")
        }
      }
      collectDefinedExport(node, commonJsExports)
    } else if (node.type === "NewExpression") {
      const callee = asNode(node.callee)
      if (callee?.type === "Identifier" && callee.name === "Proxy") {
        throw new Error("module loader proxy is forbidden")
      }
      if (forbiddenGeneratedCallee(callee)) {
        const argumentsList = Array.isArray(node.arguments) ? node.arguments : []
        if (generatedSourceCouldLoadModules(argumentsList)) {
          throw new Error("generated module loading is forbidden")
        }
      }
    } else if (node.type === "AssignmentExpression") {
      collectAssignedExports(node, commonJsExports)
    } else if (node.type === "MemberExpression") {
      if (isImportMetaResolve(node)) {
        if (parentNode?.type !== "CallExpression" || parentKey !== "callee") {
          throw new Error("import.meta.resolve aliasing is forbidden")
        }
      } else if (isForbiddenLoaderMember(node)) {
        throw new Error("generated module loading member is forbidden")
      }
      if (isReflectSafeMember(node) &&
        (parentNode?.type !== "CallExpression" || parentKey !== "callee")) {
        throw new Error("reflection capability aliasing is forbidden")
      }
    } else if (node.type === "Identifier" && isIdentifierReference(parentNode, parentKey) &&
      isSensitiveLoaderIdentifier(node, scope)) {
      if (!isAllowedSensitiveIdentifierUse(node, parentNode, parentKey)) {
        throw new Error(`module loader capability aliasing is forbidden: ${String(node.name)}`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["end", "loc", "range", "start", "type"].includes(key) || (skipCallee && key === "callee")) continue
      if (Array.isArray(value)) {
        for (const child of value) {
          const childNode = asNode(child)
          if (childNode !== undefined) visit(childNode, node, key)
        }
      } else {
        const childNode = asNode(value)
        if (childNode !== undefined) visit(childNode, node, key)
      }
    }
  }
  visit(ast)
  return { commonJsExports, edges }
}

function asNode(value: unknown): AstNode | undefined {
  return isRecord(value) && typeof value.type === "string" ? value as AstNode : undefined
}

function literalString(value: unknown): string {
  const node = asNode(value)
  if (node?.type !== "Literal" || typeof node.value !== "string") {
    throw new Error("unsafe nonliteral module loading is forbidden")
  }
  return node.value
}

function importNames(node: AstNode): string[] {
  if (!Array.isArray(node.specifiers)) return []
  return node.specifiers.flatMap((value) => {
    const specifier = asNode(value)
    if (specifier?.type === "ImportDefaultSpecifier") return ["default"]
    if (specifier?.type !== "ImportSpecifier") return []
    const imported = asNode(specifier.imported)
    return imported?.type === "Identifier" && typeof imported.name === "string"
      ? [imported.name]
      : imported?.type === "Literal" && typeof imported.value === "string" ? [imported.value] : []
  })
}

function exportNames(node: AstNode): string[] {
  if (!Array.isArray(node.specifiers)) return []
  return node.specifiers.flatMap((value) => {
    const specifier = asNode(value)
    const local = asNode(specifier?.local)
    return local?.type === "Identifier" && typeof local.name === "string"
      ? [local.name]
      : local?.type === "Literal" && typeof local.value === "string" ? [local.value] : []
  })
}

function isImportMetaResolve(node: AstNode | undefined): boolean {
  if (node?.type !== "MemberExpression" || node.computed === true) return false
  const object = asNode(node.object)
  const property = asNode(node.property)
  return object?.type === "MetaProperty" && asNode(object.meta)?.name === "import" &&
    asNode(object.property)?.name === "meta" && property?.name === "resolve"
}

interface JavaScriptScope {
  readonly bindings: Set<string>
  readonly kind: "block" | "function" | "program"
  readonly parent?: JavaScriptScope
}

function isSensitiveLoaderIdentifier(node: AstNode, scope: JavaScriptScope): boolean {
  const name = String(node.name)
  if (isShadowedJavaScriptBinding(name, scope)) return false
  return isSensitiveGlobalName(name)
}

function isSensitiveGlobalName(name: string): boolean {
  return [
    "AsyncFunction",
    "Function",
    "GeneratorFunction",
    "Proxy",
    "Reflect",
    "createRequire",
    "eval",
    "getBuiltinModule",
    "global",
    "globalThis",
    "module",
    "process",
    "require",
  ].includes(name)
}

function isAllowedSensitiveIdentifierUse(
  node: AstNode,
  parent: AstNode | undefined,
  parentKey: string | undefined,
): boolean {
  const name = String(node.name)
  if (["AsyncFunction", "Function", "GeneratorFunction"].includes(name)) {
    if ((parent?.type === "CallExpression" || parent?.type === "NewExpression") && parentKey === "callee") return true
    return parent?.type === "MemberExpression" && parentKey === "object" &&
      parent.computed !== true && memberName(parent) === "prototype"
  }
  if (name === "Reflect") {
    return parent?.type === "MemberExpression" && parentKey === "object" && isReflectSafeMember(parent)
  }
  if (["global", "globalThis", "module", "process"].includes(name)) {
    if (parent?.type === "UnaryExpression" && parent.operator === "typeof" &&
      parentKey === "argument") return true
    return parent?.type === "MemberExpression" && parentKey === "object" &&
      !isForbiddenLoaderMember(parent)
  }
  return false
}

function isIdentifierReference(
  parent: AstNode | undefined,
  parentKey: string | undefined,
): boolean {
  if (parent === undefined) return true
  if (parent.type === "MemberExpression" && parentKey === "property" &&
    parent.computed !== true) return false
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type) &&
    parentKey === "key" && parent.computed !== true) return false
  if (parent.type === "MetaProperty") return false
  if (parent.type === "LabeledStatement" && parentKey === "label") return false
  if (["BreakStatement", "ContinueStatement"].includes(parent.type) &&
    parentKey === "label") return false
  if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(
    parent.type,
  )) return false
  if (parent.type === "ExportSpecifier" && parentKey === "exported") return false
  if (["VariableDeclarator", "FunctionDeclaration", "FunctionExpression", "ClassDeclaration",
    "ClassExpression", "CatchClause"].includes(parent.type) &&
    ["id", "param", "params"].includes(String(parentKey))) return false
  return true
}

function forbiddenGeneratedCallee(node: AstNode | undefined): boolean {
  if (node?.type === "Identifier") {
    return ["AsyncFunction", "Function", "GeneratorFunction", "createRequire"].includes(
      String(node.name),
    )
  }
  return node?.type === "MemberExpression" && isForbiddenLoaderMember(node)
}

function generatedSourceCouldLoadModules(argumentsList: readonly unknown[]): boolean {
  if (argumentsList.length === 0) return false
  for (const value of argumentsList) {
    const node = asNode(value)
    if (node?.type === "Literal" && typeof node.value === "string") {
      if (generatedLoaderText(node.value)) return true
      continue
    }
    if (node?.type === "TemplateLiteral" && Array.isArray(node.quasis) &&
      Array.isArray(node.expressions)) {
      if (node.expressions.length !== 0) return true
      const staticText = node.quasis.map((quasi) => {
        const valueNode = asNode(quasi)
        const cooked = isRecord(valueNode?.value) ? valueNode.value.cooked : undefined
        if (typeof cooked !== "string") throw new Error("generated source is malformed")
        return cooked
      }).join("")
      if (generatedLoaderText(staticText)) return true
      continue
    }
    return true
  }
  return false
}

function generatedLoaderText(value: string): boolean {
  return /\b(?:createRequire|eval|Function|getBuiltinModule|import\s*\(|module\s*\.\s*(?:_load|require)|Proxy|Reflect\s*\.\s*get|require\b)/u
    .test(value)
}

function isForbiddenLoaderMember(node: AstNode): boolean {
  if (node.type !== "MemberExpression") return false
  const object = asNode(node.object)
  const name = memberName(node)
  const objectName = String(object?.name)
  if (
    node.computed === true && name === undefined &&
    ["global", "globalThis", "module", "process", "Reflect", "require"].includes(objectName)
  ) return true
  if (["createRequire", "eval", "getBuiltinModule", "require"].includes(String(name))) return true
  if (name === "resolve") return object?.name === "require" || isImportMetaResolve(node)
  if (name === "_load") return objectName === "module"
  if (objectName === "Reflect") return !["apply", "ownKeys"].includes(String(name))
  if (["global", "globalThis"].includes(objectName) &&
    [
      "AsyncFunction",
      "Function",
      "GeneratorFunction",
      "Proxy",
      "Reflect",
      "createRequire",
      "eval",
      "module",
      "process",
      "require",
    ].includes(String(name))) return true
  if (["compileFunction", "runInThisContext"].includes(String(name))) {
    return objectName === "vm"
  }
  return false
}

function isReflectSafeMember(node: AstNode): boolean {
  return node.type === "MemberExpression" && asNode(node.object)?.name === "Reflect" &&
    node.computed !== true && ["apply", "ownKeys"].includes(String(memberName(node)))
}

function memberName(node: AstNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined
  const property = asNode(node.property)
  if (node.computed !== true) return typeof property?.name === "string" ? property.name : undefined
  return staticStringValue(property)
}

function literalMemberName(node: AstNode | undefined): unknown {
  return staticStringValue(node)
}

function staticStringValue(node: AstNode | undefined): string | undefined {
  if (node?.type === "Literal") return typeof node.value === "string" ? node.value : undefined
  if (node?.type === "TemplateLiteral" && Array.isArray(node.expressions) &&
    node.expressions.length === 0 && Array.isArray(node.quasis)) {
    return node.quasis.map((value) => {
      const quasi = asNode(value)
      const cooked = isRecord(quasi?.value) ? quasi.value.cooked : undefined
      return typeof cooked === "string" ? cooked : ""
    }).join("")
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringValue(asNode(node.left))
    const right = staticStringValue(asNode(node.right))
    return left === undefined || right === undefined ? undefined : `${left}${right}`
  }
  return undefined
}

function buildJavaScriptScopes(ast: AstNode): WeakMap<object, JavaScriptScope> {
  const scopes = new WeakMap<object, JavaScriptScope>()
  const root: JavaScriptScope = { bindings: new Set(), kind: "program" }
  const walk = (
    node: AstNode,
    inherited: JavaScriptScope,
    parent?: AstNode,
    parentKey?: string,
  ): void => {
    let scope = inherited
    if (isFunctionNode(node)) {
      if (node.type === "FunctionDeclaration") addPatternBindings(asNode(node.id), inherited)
      scope = { bindings: new Set(), kind: "function", parent: inherited }
      if (node.type === "FunctionExpression") addPatternBindings(asNode(node.id), scope)
      if (Array.isArray(node.params)) {
        for (const parameter of node.params) addPatternBindings(asNode(parameter), scope)
      }
    } else if (createsJavaScriptBlockScope(node, parent, parentKey)) {
      scope = { bindings: new Set(), kind: "block", parent: inherited }
    }
    scopes.set(node, scope)
    if (node.type === "VariableDeclaration" && Array.isArray(node.declarations)) {
      const target = node.kind === "var" ? nearestFunctionScope(scope) : scope
      for (const declaration of node.declarations) {
        addPatternBindings(asNode(asNode(declaration)?.id), target)
      }
    } else if (node.type === "ClassDeclaration") {
      addPatternBindings(asNode(node.id), scope)
    } else if (node.type === "ClassExpression") {
      addPatternBindings(asNode(node.id), scope)
    } else if (node.type === "ImportDeclaration" && Array.isArray(node.specifiers)) {
      for (const specifier of node.specifiers) {
        addPatternBindings(asNode(asNode(specifier)?.local), scope)
      }
    } else if (node.type === "CatchClause") {
      addPatternBindings(asNode(node.param), scope)
    }
    for (const [key, value] of Object.entries(node)) {
      if (["end", "loc", "range", "start", "type"].includes(key)) continue
      if (Array.isArray(value)) {
        for (const child of value) {
          const childNode = asNode(child)
          if (childNode !== undefined) walk(childNode, scope, node, key)
        }
      } else {
        const childNode = asNode(value)
        if (childNode !== undefined) walk(childNode, scope, node, key)
      }
    }
  }
  walk(ast, root)
  return scopes
}

function createsJavaScriptBlockScope(
  node: AstNode,
  parent: AstNode | undefined,
  parentKey: string | undefined,
): boolean {
  if (node.type === "Program") return false
  if (node.type === "BlockStatement") {
    if (isFunctionNode(parent) && parentKey === "body") return false
    if (parent?.type === "CatchClause" && parentKey === "body") return false
    return true
  }
  return [
    "CatchClause",
    "ForInStatement",
    "ForOfStatement",
    "ForStatement",
    "StaticBlock",
    "SwitchStatement",
  ].includes(node.type)
}

function isFunctionNode(node: AstNode | undefined): boolean {
  return [
    "ArrowFunctionExpression",
    "FunctionDeclaration",
    "FunctionExpression",
  ].includes(String(node?.type))
}

function nearestFunctionScope(scope: JavaScriptScope): JavaScriptScope {
  let current = scope
  while (current.kind === "block" && current.parent !== undefined) current = current.parent
  return current
}

function addPatternBindings(pattern: AstNode | undefined, scope: JavaScriptScope): void {
  if (pattern === undefined) return
  if (pattern.type === "Identifier" && typeof pattern.name === "string") {
    scope.bindings.add(pattern.name)
    return
  }
  if (pattern.type === "AssignmentPattern") {
    addPatternBindings(asNode(pattern.left), scope)
    return
  }
  if (pattern.type === "RestElement") {
    addPatternBindings(asNode(pattern.argument), scope)
    return
  }
  if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements)) {
    for (const element of pattern.elements) addPatternBindings(asNode(element), scope)
    return
  }
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties)) {
    for (const value of pattern.properties) {
      const property = asNode(value)
      addPatternBindings(
        property?.type === "RestElement" ? asNode(property.argument) : asNode(property?.value),
        scope,
      )
    }
  }
}

function isShadowedJavaScriptBinding(name: string, scope: JavaScriptScope): boolean {
  let current: JavaScriptScope | undefined = scope
  while (current !== undefined) {
    if (current.bindings.has(name)) return true
    current = current.parent
  }
  return false
}

function collectAssignedExports(node: AstNode, names: Set<string>): void {
  const left = asNode(node.left)
  const name = exportedMemberName(left)
  if (name !== undefined) names.add(name)
  if (isModuleExports(left)) {
    const right = asNode(node.right)
    if (right?.type === "ObjectExpression" && Array.isArray(right.properties)) {
      for (const value of right.properties) {
        const property = asNode(value)
        const key = asNode(property?.key)
        const propertyName = property?.computed === true ? literalMemberName(key) : key?.name ?? literalMemberName(key)
        if (typeof propertyName === "string") names.add(propertyName)
      }
    }
  }
}

function collectDefinedExport(node: AstNode, names: Set<string>): void {
  const callee = asNode(node.callee)
  if (callee?.type !== "MemberExpression" || callee.computed === true) return
  if (asNode(callee.object)?.name !== "Object" || asNode(callee.property)?.name !== "defineProperty") return
  const argumentsList = Array.isArray(node.arguments) ? node.arguments : []
  if (argumentsList.length < 2) return
  const target = asNode(argumentsList[0])
  if (target?.name !== "exports" && !isModuleExports(target)) return
  const name = literalString(argumentsList[1])
  names.add(name)
}

function exportedMemberName(node: AstNode | undefined): string | undefined {
  if (node?.type !== "MemberExpression") return undefined
  const object = asNode(node.object)
  const property = asNode(node.property)
  const objectIsExports = object?.name === "exports" || isModuleExports(object)
  if (!objectIsExports) return undefined
  const name = node.computed === true ? literalMemberName(property) : property?.name
  return typeof name === "string" ? name : undefined
}

function isModuleExports(node: AstNode | undefined): boolean {
  return node?.type === "MemberExpression" && node.computed !== true &&
    asNode(node.object)?.name === "module" && asNode(node.property)?.name === "exports"
}

function packageRootFor(
  path: string,
  root: string,
  fileAt: (path: string) => HeldFile | undefined,
): string {
  let cursor = dirname(path)
  for (;;) {
    if (fileAt(resolve(cursor, "package.json")) !== undefined) return cursor
    if (resolve(cursor) === resolve(root)) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    const parent = dirname(cursor)
    if (parent === cursor) throw new ResolutionError("MODULE_NOT_FOUND_TARGET")
    cursor = parent
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
