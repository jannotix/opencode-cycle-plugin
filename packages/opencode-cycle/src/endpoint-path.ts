import { join } from "node:path"

export const MAX_LINUX_UNIX_SOCKET_PATH_BYTES = 107

export function controlPlaneUnixSocketPath(dataDirectory: string): string {
  return join(dataDirectory, "runtime", "workflow.sock")
}

export function controlPlaneUnixSocketPathBytes(dataDirectory: string): number {
  return Buffer.byteLength(controlPlaneUnixSocketPath(dataDirectory))
}

export function assertControlPlaneUnixSocketPath(dataDirectory: string): number {
  const bytes = controlPlaneUnixSocketPathBytes(dataDirectory)
  if (bytes > MAX_LINUX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("workflowd endpoint_path exceeds the Linux Unix socket bound")
  }
  return bytes
}
