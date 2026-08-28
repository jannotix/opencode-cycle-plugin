import { posix, win32 } from "node:path"

import {
  assertControlPlaneUnixSocketPath,
  MAX_LINUX_UNIX_SOCKET_PATH_BYTES,
} from "../../packages/opencode-cycle/src/endpoint-path.js"

export { MAX_LINUX_UNIX_SOCKET_PATH_BYTES }

/**
 * The platform argument decides the path flavour, never the host.
 *
 * These helpers measure a layout that has to fit the Linux Unix socket bound.
 * Computing it with the host's separator means a Windows machine measures a
 * path that will never exist, and a Linux machine measures the Windows one:
 * in production the two agree, so only a cross-platform lane reveals it.
 */
function pathFlavour(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix
}

export function packedPluginScratchPrefix(platform: NodeJS.Platform): string {
  return platform === "linux" ? "ocp-" : "opencode-cycle-packed-plugin-"
}

export function packedPluginDataDirectory(scratch: string, platform: NodeJS.Platform): string {
  const path = pathFlavour(platform)
  const root = path.resolve(scratch)
  if (!path.isAbsolute(scratch) || root !== scratch || scratch.includes("\0")) {
    throw new Error("Packed plugin scratch path is invalid")
  }
  return path.join(root, platform === "linux" ? "d" : "runtime-data")
}

export function packedPluginDaemonEndpointEvidence(
  dataDirectory: string,
  platform: NodeJS.Platform,
): {
  readonly endpointKind: "named_pipe" | "unix_socket"
  readonly endpointPathBytes: number
} {
  const path = pathFlavour(platform)
  const root = path.resolve(dataDirectory)
  if (!path.isAbsolute(dataDirectory) || root !== dataDirectory || dataDirectory.includes("\0")) {
    throw new Error("Packed plugin daemon data path is invalid")
  }
  if (platform !== "linux") return { endpointKind: "named_pipe", endpointPathBytes: 0 }
  const endpointPathBytes = assertControlPlaneUnixSocketPath(root)
  return { endpointKind: "unix_socket", endpointPathBytes }
}
