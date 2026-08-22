import { gunzipSync } from "node:zlib"

const BLOCK_SIZE = 512

interface TarLimits {
  readonly maxCompressedBytes: number
  readonly maxEntries: number
  readonly maxMemberBytes: number
  readonly maxMetadataBytes: number
  readonly maxTotalContentBytes: number
  readonly maxUncompressedBytes: number
}

const PRODUCTION_LIMITS: TarLimits = Object.freeze({
  maxCompressedBytes: 128 * 1024 * 1024,
  maxEntries: 2_048,
  maxMemberBytes: 256 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  maxTotalContentBytes: 300 * 1024 * 1024,
  maxUncompressedBytes: 320 * 1024 * 1024,
})

export interface VerifiedTarEntry {
  /** A defensive copy, created only when a caller needs the member bytes. */
  readonly content: Buffer
  readonly name: string
  readonly size: number
}

export function inspectTarGz(content: Uint8Array): VerifiedTarEntry[] {
  return inspectTarGzWithLimits(content, PRODUCTION_LIMITS)
}

/** Test-only construction keeps production limits immutable and non-configurable. */
export function createTarInspectorForTests(limits: TarLimits): typeof inspectTarGz {
  validateLimits(limits)
  return (content) => inspectTarGzWithLimits(content, limits)
}

function inspectTarGzWithLimits(content: Uint8Array, limits: TarLimits): VerifiedTarEntry[] {
  if (content.byteLength > limits.maxCompressedBytes) {
    throw new Error("Tar archive exceeds the compressed size limit")
  }
  let archive: Buffer
  try {
    archive = gunzipSync(content, { maxOutputLength: limits.maxUncompressedBytes })
  } catch {
    throw new Error("Tar archive gzip stream is invalid or exceeds the uncompressed size limit")
  }
  if (archive.byteLength < 2 * BLOCK_SIZE || archive.byteLength % BLOCK_SIZE !== 0) {
    throw new Error("Tar archive is truncated or not block-aligned")
  }

  const entries: VerifiedTarEntry[] = []
  const names = new Set<string>()
  let metadataBytes = 0
  let totalContentBytes = 0
  let offset = 0
  let ended = false
  while (offset + BLOCK_SIZE <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) {
      const secondTerminator = archive.subarray(offset + BLOCK_SIZE, offset + 2 * BLOCK_SIZE)
      if (secondTerminator.byteLength !== BLOCK_SIZE || !isZeroBlock(secondTerminator)) {
        throw new Error("Tar archive has no valid two-block terminator")
      }
      ended = true
      offset += 2 * BLOCK_SIZE
      break
    }

    if (entries.length >= limits.maxEntries) throw new Error("Tar archive has too many entries")
    validateHeaderChecksum(header)
    validateUstarHeader(header)
    const name = tarPath(header)
    validateTarPath(name)
    metadataBytes += Buffer.byteLength(name, "utf8")
    if (metadataBytes > limits.maxMetadataBytes) {
      throw new Error("Tar archive exceeds the metadata size limit")
    }
    if (names.has(name)) throw new Error(`Tar archive contains duplicate member: ${name}`)
    names.add(name)

    const type = header[156]
    if (type !== 0 && type !== "0".charCodeAt(0)) {
      throw new Error(`Tar archive member is not a regular file: ${name}`)
    }
    const size = parseOctal(header.subarray(124, 136), `size for ${name}`)
    if (size > limits.maxMemberBytes) throw new Error(`Tar archive member is too large: ${name}`)
    totalContentBytes += size
    if (totalContentBytes > limits.maxTotalContentBytes) {
      throw new Error("Tar archive exceeds the total content size limit")
    }

    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size
    const paddedEnd = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (dataEnd > archive.byteLength || paddedEnd > archive.byteLength) {
      throw new Error(`Tar archive member is truncated: ${name}`)
    }
    if (archive.subarray(dataEnd, paddedEnd).some((byte) => byte !== 0)) {
      throw new Error(`Tar archive member padding is non-zero: ${name}`)
    }
    entries.push({
      get content(): Buffer {
        return Buffer.from(archive.subarray(dataStart, dataEnd))
      },
      name,
      size,
    })
    offset = paddedEnd
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

function validateUstarHeader(header: Uint8Array): void {
  const magic = Buffer.from(header.subarray(257, 263)).toString("binary")
  const version = Buffer.from(header.subarray(263, 265)).toString("binary")
  if (magic !== "ustar\0" || version !== "00") {
    throw new Error("Tar archive is outside the supported ustar subset")
  }
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
  if ((value[0] as number) >= 0x80) throw new Error(`Tar archive ${label} is not octal`)
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

function isZeroBlock(block: Uint8Array): boolean {
  return block.byteLength === BLOCK_SIZE && block.every((byte) => byte === 0)
}

function validateLimits(limits: TarLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid test tar limit: ${name}`)
  }
}
