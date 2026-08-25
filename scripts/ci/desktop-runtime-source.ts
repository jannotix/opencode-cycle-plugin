import type { DesktopCertificationBinding } from "../../packages/opencode-cycle/src/certification.js"
import type { DesktopDependencyTreeReceipt } from "./desktop-dependency-tree.js"

interface DesktopRuntimeChildSourceExpected {
  readonly candidateEntry: string
  readonly candidateEntrySha256: string
  readonly dependencyTreeSha256: string
  readonly electronVersion: string
  readonly nodeVersion: string
}

export interface DesktopRuntimeSupervisorSourceExpected {
  readonly binding: DesktopCertificationBinding
  readonly bindingDigest: string
  readonly candidateEntry: string
  readonly candidateEntrySha256: string
  readonly childEnvironment: Readonly<Record<string, string>>
  readonly childWrapper: string
  readonly childWrapperSha256: string
  readonly configDirectory: string
  readonly configFile: string
  readonly cwd: string
  readonly dependencyTree: DesktopDependencyTreeReceipt
  readonly diagnosticsFile: string
  readonly electronVersion: string
  readonly environmentBindings: Readonly<Record<string, string>>
  readonly hostVersion: string
  readonly loader: string
  readonly loaderSha256: string
  readonly nodeVersion: string
  readonly resultFile: string
  readonly scratch: string
}

export function desktopRuntimeChildSource(
  expected: DesktopRuntimeChildSourceExpected,
): string {
  return `import { createHash, createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const expected = ${JSON.stringify(expected)}
const privateWrite = process.stdout.write.bind(process.stdout)
const privateExit = process.exit.bind(process)
const privateStringify = JSON.stringify.bind(JSON)
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
if (typeof process.send !== "function") throw new Error("private channel")
const challenge = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("challenge timeout")), 10_000)
  process.once("message", (message) => {
    clearTimeout(timeout)
    if (
      !message || typeof message !== "object" || Array.isArray(message) ||
      Object.keys(message).sort().join(",") !== "challenge,type" ||
      message.type !== "runtime-challenge" ||
      typeof message.challenge !== "string" ||
      !/^[0-9a-f]{64}$/.test(message.challenge)
    ) return reject(new Error("challenge"))
    resolve(message.challenge)
  })
})
process.removeAllListeners("message")
if (process.connected) process.disconnect()
for (const name of ["send", "channel", "_channel"]) {
  try { Object.defineProperty(process, name, { configurable: false, value: undefined, writable: false }) } catch {}
}
if (
  process.versions.electron !== expected.electronVersion ||
  process.versions.node !== expected.nodeVersion ||
  digest(expected.candidateEntry) !== expected.candidateEntrySha256
) throw new Error("runtime binding")
const candidate = await import(pathToFileURL(expected.candidateEntry).href)
if (
  Object.keys(candidate).sort().join(",") !== "default" ||
  typeof candidate.default !== "function" ||
  digest(expected.candidateEntry) !== expected.candidateEntrySha256
) throw new Error("candidate import")
const payload = {
  candidateEntrySha256: expected.candidateEntrySha256,
  childWrapperSha256: digest(fileURLToPath(import.meta.url)),
  dependencyTreeSha256: expected.dependencyTreeSha256,
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  runtimeExecutableSha256: digest(process.execPath),
}
const acknowledgement = createHmac("sha256", Buffer.from(challenge, "hex"))
  .update(privateStringify(payload))
  .digest("hex")
privateWrite(
  privateStringify({ acknowledgement, payload, type: "runtime-imported" }) + "\\n",
  (error) => privateExit(error ? 1 : 0),
)
`
}

export function desktopRuntimeSupervisorSource(
  expected: DesktopRuntimeSupervisorSourceExpected,
): string {
  return `import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { fork } from "node:child_process"
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const expected = ${JSON.stringify(expected)}
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
const canonicalPayload = (payload) => JSON.stringify({
  candidateEntrySha256: payload.candidateEntrySha256,
  childWrapperSha256: payload.childWrapperSha256,
  dependencyTreeSha256: payload.dependencyTreeSha256,
  electronVersion: payload.electronVersion,
  nodeVersion: payload.nodeVersion,
  runtimeExecutableSha256: payload.runtimeExecutableSha256,
})
const bindingDigest = createHash("sha256").update(JSON.stringify({
  nativePackageSha256: expected.binding.nativePackageSha256,
  nonce: expected.binding.nonce,
  pluginPackageSha256: expected.binding.pluginPackageSha256,
  revision: expected.binding.revision,
  root: expected.binding.root,
  startedAtUnixMillis: expected.binding.startedAtUnixMillis,
})).digest("hex")
if (
  process.versions.electron !== expected.electronVersion ||
  process.versions.node !== expected.nodeVersion ||
  process.env.CYCLE_DESKTOP_RUNTIME_GUARD !== expected.bindingDigest ||
  bindingDigest !== expected.bindingDigest ||
  resolve(process.cwd()) !== expected.cwd
) throw new Error("runtime identity")
const runtimeExecutableSha256 = digest(process.execPath)
const config = JSON.parse(readFileSync(expected.configFile, "utf8"))
if (!Array.isArray(config.plugin) || config.plugin.length !== 1 || !Array.isArray(config.plugin[0])) {
  throw new Error("config tuple")
}
const [specifier, options] = config.plugin[0]
if (
  specifier !== pathToFileURL(expected.loader).href ||
  !options || typeof options !== "object" || Array.isArray(options) ||
  Object.keys(options).sort().join(",") !== "binaryPath,certification,dataDirectory,hostVersion" ||
  JSON.stringify(options.certification) !== JSON.stringify(expected.binding) ||
  options.hostVersion !== expected.hostVersion ||
  !isAbsolute(options.binaryPath) || !isAbsolute(options.dataDirectory) ||
  digest(expected.candidateEntry) !== expected.candidateEntrySha256 ||
  digest(expected.loader) !== expected.loaderSha256 ||
  digest(expected.childWrapper) !== expected.childWrapperSha256
) throw new Error("config binding")
const manifest = JSON.parse(readFileSync(resolve(expected.candidateEntry, "..", "..", "package.json"), "utf8"))
if (manifest?.exports?.["."] !== "./dist/index.js") throw new Error("candidate export")
const isInside = (path) => {
  const value = relative(expected.scratch, resolve(path))
  return value === "" || (value !== ".." && !value.startsWith(".." + sep))
}
for (const [name, value] of Object.entries(expected.environmentBindings)) {
  if (process.env[name] !== value) throw new Error("environment binding")
}
for (const path of [
  expected.configDirectory,
  dirname(expected.configFile),
  process.cwd(),
  process.env.HOME,
  process.env.TEMP,
  process.env.TMP,
  process.env.TMPDIR,
]) {
  if (typeof path !== "string" || !isInside(path)) throw new Error("environment path")
}

const stages = [
  "certification_env_prepared",
  "config_tree_prepared",
  "config_path_discovered",
  "plugin_specifier_resolved",
  "effective_env_validated",
  "candidate_module_resolved",
]
const readTranscript = () => readFileSync(expected.diagnosticsFile, "utf8")
  .split("\\n").filter(Boolean).map((line, sequence) => {
    const record = JSON.parse(line)
    if (
      !record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== "runDigest,schemaVersion,sequence,stage,status,type" ||
      record.runDigest !== expected.bindingDigest ||
      record.schemaVersion !== 2 ||
      record.sequence !== sequence ||
      record.stage !== stages[sequence] ||
      record.status !== "passed" ||
      record.type !== "opencode-cycle-desktop-load-diagnostic"
    ) throw new Error("diagnostic transcript")
    return record
  })
const appendDiagnostic = (stage) => {
  const transcript = readTranscript()
  if (stages[transcript.length] !== stage) throw new Error("diagnostic transition")
  const handle = openSync(expected.diagnosticsFile, "a", 0o600)
  try {
    writeSync(handle, JSON.stringify({
      runDigest: expected.bindingDigest,
      schemaVersion: 2,
      sequence: transcript.length,
      stage,
      status: "passed",
      type: "opencode-cycle-desktop-load-diagnostic",
    }) + "\\n", undefined, "utf8")
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}
appendDiagnostic("config_path_discovered")
appendDiagnostic("plugin_specifier_resolved")
appendDiagnostic("effective_env_validated")

const child = fork(expected.childWrapper, [], {
  cwd: expected.cwd,
  env: expected.childEnvironment,
  execArgv: [],
  execPath: process.execPath,
  serialization: "json",
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  windowsHide: true,
})
const challenge = randomBytes(32)
child.send({ challenge: challenge.toString("hex"), type: "runtime-challenge" })
const readBounded = async (stream) => {
  const chunks = []
  let bytes = 0
  for await (const value of stream) {
    const chunk = Buffer.from(value)
    bytes += chunk.byteLength
    if (bytes > 64 * 1024) {
      child.kill()
      throw new Error("child output limit")
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
let timeout
const exited = new Promise((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", (code) => resolve(code ?? 1))
})
const boundedExit = Promise.race([
  exited,
  new Promise((resolve) => {
    timeout = setTimeout(() => {
      child.kill()
      resolve(124)
    }, 30_000)
  }),
])
let exitCode
let stdout
let stderr
try {
  ;[exitCode, stdout, stderr] = await Promise.all([
    boundedExit,
    readBounded(child.stdout),
    readBounded(child.stderr),
  ])
} finally {
  clearTimeout(timeout)
}
if (exitCode !== 0 || stderr.length !== 0) throw new Error("child execution")
const acknowledgementFrame = stdout.toString("utf8")
let message
try {
  if (
    !acknowledgementFrame.endsWith("\\n") ||
    acknowledgementFrame.indexOf("\\n") !== acknowledgementFrame.length - 1
  ) throw new Error("framing")
  message = JSON.parse(acknowledgementFrame.slice(0, -1))
} catch {
  throw new Error("child acknowledgement")
}
if (
  !message || typeof message !== "object" || Array.isArray(message) ||
  Object.keys(message).sort().join(",") !== "acknowledgement,payload,type" ||
  message.type !== "runtime-imported" ||
  typeof message.acknowledgement !== "string" ||
  !/^[0-9a-f]{64}$/.test(message.acknowledgement)
) throw new Error("child acknowledgement")
const expectedPayload = {
  candidateEntrySha256: expected.candidateEntrySha256,
  childWrapperSha256: expected.childWrapperSha256,
  dependencyTreeSha256: expected.dependencyTree.dependencyTreeSha256,
  electronVersion: expected.electronVersion,
  nodeVersion: expected.nodeVersion,
  runtimeExecutableSha256,
}
if (canonicalPayload(message.payload) !== canonicalPayload(expectedPayload)) {
  throw new Error("child payload")
}
const acknowledgement = createHmac("sha256", challenge)
  .update(canonicalPayload(expectedPayload))
  .digest("hex")
if (
  !timingSafeEqual(Buffer.from(message.acknowledgement), Buffer.from(acknowledgement))
) throw new Error("child acknowledgement")
appendDiagnostic("candidate_module_resolved")
const receipt = {
  acknowledgementSha256: createHash("sha256").update(message.acknowledgement).digest("hex"),
  bindingDigest: expected.bindingDigest,
  candidateEntrySha256: expected.candidateEntrySha256,
  childExitCode: exitCode,
  childWrapperSha256: expected.childWrapperSha256,
  dependencyFileCount: expected.dependencyTree.dependencyFileCount,
  dependencyPackageCount: expected.dependencyTree.dependencyPackageCount,
  dependencyTotalBytes: expected.dependencyTree.dependencyTotalBytes,
  dependencyTreeSha256: expected.dependencyTree.dependencyTreeSha256,
  electronVersion: process.versions.electron,
  loaderSha256: expected.loaderSha256,
  moduleResolved: true,
  nativePackageSha256: expected.binding.nativePackageSha256,
  nodeVersion: process.versions.node,
  pluginPackageSha256: expected.binding.pluginPackageSha256,
  productVersion: expected.hostVersion,
  revision: expected.binding.revision,
  runtimeExecutableSha256,
  schemaVersion: 2,
  supervisorSha256: digest(fileURLToPath(import.meta.url)),
  type: "opencode-cycle-desktop-runtime-guard",
}
const handle = openSync(expected.resultFile, "wx", 0o600)
try {
  writeSync(handle, JSON.stringify(receipt) + "\\n", undefined, "utf8")
  fsyncSync(handle)
} finally {
  closeSync(handle)
}
`
}
