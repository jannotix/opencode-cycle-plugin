import { createHmac, timingSafeEqual } from "node:crypto"

export interface DesktopRuntimeChildPayload {
  readonly candidateEntrySha256: string
  readonly childWrapperSha256: string
  readonly dependencyTreeSha256: string
  readonly electronVersion: string
  readonly nodeVersion: string
  readonly runtimeExecutableSha256: string
}

export interface DesktopRuntimeChildMessage {
  readonly acknowledgement: string
  readonly payload: DesktopRuntimeChildPayload
  readonly type: "runtime-imported"
}

export function createDesktopRuntimeAcknowledgement(
  challenge: Uint8Array,
  payload: DesktopRuntimeChildPayload,
): string {
  if (challenge.byteLength !== 32) throw new Error("Desktop runtime challenge is invalid")
  assertDesktopRuntimeChildPayload(payload)
  return createHmac("sha256", challenge)
    .update(canonicalDesktopRuntimeChildPayload(payload))
    .digest("hex")
}

export function validateDesktopRuntimeChildResult(input: {
  readonly challenge: Uint8Array
  readonly exitCode: number
  readonly expectedPayload: DesktopRuntimeChildPayload
  readonly stderr: Buffer
  readonly stdout: Buffer
}): void {
  if (input.exitCode !== 0 || input.stderr.length !== 0 || input.stdout.length > 64 * 1024) {
    throw new Error("Desktop runtime child acknowledgement is missing or invalid")
  }
  const text = input.stdout.toString("utf8")
  let message: unknown
  try {
    if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
      throw new Error("framing")
    }
    message = JSON.parse(text.slice(0, -1)) as unknown
  } catch {
    throw new Error("Desktop runtime child acknowledgement is missing or invalid")
  }
  if (
    !isRecord(message) ||
    Object.keys(message).sort().join(",") !== "acknowledgement,payload,type" ||
    message.type !== "runtime-imported" ||
    typeof message.acknowledgement !== "string" ||
    !/^[0-9a-f]{64}$/u.test(message.acknowledgement)
  ) throw new Error("Desktop runtime child acknowledgement is missing or invalid")
  assertDesktopRuntimeChildPayload(message.payload)
  if (
    canonicalDesktopRuntimeChildPayload(message.payload) !==
      canonicalDesktopRuntimeChildPayload(input.expectedPayload)
  ) throw new Error("Desktop runtime child acknowledgement payload is invalid")
  const expected = createDesktopRuntimeAcknowledgement(input.challenge, input.expectedPayload)
  if (!timingSafeEqual(Buffer.from(message.acknowledgement), Buffer.from(expected))) {
    throw new Error("Desktop runtime child acknowledgement is invalid")
  }
}
export function desktopRuntimeChildEnvironment(
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const safe = [
    "APPDIR",
    "APPIMAGE",
    "LD_LIBRARY_PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
  ]
  return {
    ...Object.fromEntries(safe.flatMap((name) => {
      const value = environment[name]
      return typeof value === "string" && value.length !== 0 ? [[name, value]] : []
    })),
    ELECTRON_RUN_AS_NODE: "1",
  }
}

export function canonicalDesktopRuntimeChildPayload(
  payload: DesktopRuntimeChildPayload,
): string {
  return JSON.stringify({
    candidateEntrySha256: payload.candidateEntrySha256,
    childWrapperSha256: payload.childWrapperSha256,
    dependencyTreeSha256: payload.dependencyTreeSha256,
    electronVersion: payload.electronVersion,
    nodeVersion: payload.nodeVersion,
    runtimeExecutableSha256: payload.runtimeExecutableSha256,
  })
}

function assertDesktopRuntimeChildPayload(
  value: unknown,
): asserts value is DesktopRuntimeChildPayload {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "candidateEntrySha256,childWrapperSha256,dependencyTreeSha256,electronVersion,nodeVersion,runtimeExecutableSha256" ||
    typeof value.candidateEntrySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.candidateEntrySha256) ||
    typeof value.childWrapperSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.childWrapperSha256) ||
    typeof value.dependencyTreeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.dependencyTreeSha256) ||
    typeof value.electronVersion !== "string" ||
    value.electronVersion.length === 0 ||
    typeof value.nodeVersion !== "string" ||
    value.nodeVersion.length === 0 ||
    typeof value.runtimeExecutableSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.runtimeExecutableSha256)
  ) throw new Error("Desktop runtime child acknowledgement payload is invalid")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
