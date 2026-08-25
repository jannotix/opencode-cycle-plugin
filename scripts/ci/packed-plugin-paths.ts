import { isAbsolute, join, resolve } from "node:path"

import {
  assertControlPlaneUnixSocketPath,
  MAX_LINUX_UNIX_SOCKET_PATH_BYTES,
} from "../../packages/opencode-cycle/src/endpoint-path.js"

export { MAX_LINUX_UNIX_SOCKET_PATH_BYTES }

export function packedPluginScratchPrefix(platform: NodeJS.Platform): string {
  return platform === "linux" ? "ocp-" : "opencode-cycle-packed-plugin-"
}

export function packedPluginDataDirectory(scratch: string, platform: NodeJS.Platform): string {
  const root = resolve(scratch)
  if (!isAbsolute(scratch) || root !== scratch || scratch.includes("\0")) {
    throw new Error("Packed plugin scratch path is invalid")
  }
  return join(root, platform === "linux" ? "d" : "runtime-data")
}

export function packedPluginDaemonEndpointEvidence(
  dataDirectory: string,
  platform: NodeJS.Platform,
): {
  readonly endpointKind: "named_pipe" | "unix_socket"
  readonly endpointPathBytes: number
} {
  const root = resolve(dataDirectory)
  if (!isAbsolute(dataDirectory) || root !== dataDirectory || dataDirectory.includes("\0")) {
    throw new Error("Packed plugin daemon data path is invalid")
  }
  if (platform !== "linux") return { endpointKind: "named_pipe", endpointPathBytes: 0 }
  const endpointPathBytes = assertControlPlaneUnixSocketPath(root)
  return { endpointKind: "unix_socket", endpointPathBytes }
}
