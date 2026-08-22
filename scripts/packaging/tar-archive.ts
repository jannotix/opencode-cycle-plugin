import { gunzipSync } from "node:zlib"

const BLOCK_SIZE = 512
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

export interface VerifiedTarEntry {
  readonly content: Buffer
  readonly name: string
}

export function inspectTarGz(content: Uint8Array): VerifiedTarEntry[] {
  const archive = gunzipSync(content, { maxOutputLength: MAX_UNCOMPRESSED_BYTES })
  const entries: VerifiedTarEntry[] = []
  const names = new Set<string>()
  let offset = 0
  let ended = false
  while (offset + BLOCK_SIZE <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    if (header.every((byte) => byte === 0)) {
      ended = true
      offset += BLOCK_SIZE
      break
    }
    validateHeaderChecksum(header)
    const name = tarPath(header)
    validateTarPath(name)
    if (names.has(name)) throw new Error(`Tar archive contains duplicate member: ${name}`)
    names.add(name)
    const type = header[156]
    if (type !== 0 && type !== "0".charCodeAt(0)) {
      throw new Error(`Tar archive member is not a regular file: ${name}`)
    }
    const size = parseOctal(header.subarray(124, 136), `size for ${name}`)
    if (size > MAX_UNCOMPRESSED_BYTES) throw new Error(`Tar archive member is too large: ${name}`)
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size
    if (dataEnd > archive.byteLength) throw new Error(`Tar archive member is truncated: ${name}`)
    entries.push({ content: Buffer.from(archive.subarray(dataStart, dataEnd)), name })
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
  }
  if (!ended || archive.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error("Tar archive has no valid zero-block terminator")
  }
  return entries
}

function validateHeaderChecksum(header: Uint8Array): void {
  const recorded = parseOctal(header.subarray(148, 156), "header checksum")
  let calculated = 0
  for (let index = 0; index < header.length; index += 1) {
    calculated += index >= 148 && index < 156 ? 0x20 : (header[index] as number)
  }
  if (recorded !== calculated) throw new Error("Tar archive header checksum is invalid")
}

function tarPath(header: Uint8Array): string {
  const name = tarString(header.subarray(0, 100))
  const prefix = tarString(header.subarray(345, 500))
  return prefix.length === 0 ? name : `${prefix}/${name}`
}

function tarString(value: Uint8Array): string {
  const end = value.indexOf(0)
  const bytes = end < 0 ? value : value.subarray(0, end)
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

function parseOctal(value: Uint8Array, label: string): number {
  const text = tarString(value).trim()
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Tar archive ${label} is not octal`)
  const parsed = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Tar archive ${label} is invalid`)
  return parsed
}

function validateTarPath(name: string): void {
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Tar archive member path is unsafe: ${name}`)
  }
}
