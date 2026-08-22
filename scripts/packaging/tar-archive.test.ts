import { expect, test } from "bun:test"
import { gzipSync } from "node:zlib"

import { createTarInspectorForTests, inspectTarGz } from "./tar-archive.js"

test("verified tar parser preserves exact regular members and rejects duplicates", () => {
  const archive = tarGz([
    ["package/package.json", Buffer.from("{}")],
    ["package/dist/index.js", Buffer.from("export {}")],
  ])
  expect(inspectTarGz(archive).map((entry) => [entry.name, entry.content.toString("utf8")])).toEqual([
    ["package/package.json", "{}"],
    ["package/dist/index.js", "export {}"],
  ])
  const duplicate = tarGz([
    ["package/package.json", Buffer.from("{}")],
    ["package/package.json", Buffer.from("{\"changed\":true}")],
  ])
  expect(() => inspectTarGz(duplicate)).toThrow("duplicate")
})

test("verified tar parser rejects unsafe paths and corrupt headers", () => {
  expect(() => inspectTarGz(tarGz([["../escape", Buffer.from("x")]]))).toThrow("unsafe")
  const corrupt = tarGzRaw([["package/package.json", Buffer.from("{}")]])
  corrupt[20] = (corrupt[20] as number) ^ 1
  expect(() => inspectTarGz(gzipSync(corrupt))).toThrow("checksum")
})

test("verified tar parser enforces compressed, inflated, member, entry, and metadata bounds", () => {
  const inspect = createTarInspectorForTests({
    maxCompressedBytes: 512,
    maxEntries: 2,
    maxMemberBytes: 4,
    maxMetadataBytes: 20,
    maxTotalContentBytes: 6,
    maxUncompressedBytes: 3 * 1024,
  })
  expect(() => inspect(Buffer.alloc(513))).toThrow("compressed")
  expect(() => inspect(tarGz([["package/large", Buffer.alloc(5)]]))).toThrow("member")
  expect(() =>
    inspect(
      tarGz([
        ["package/a", Buffer.alloc(3)],
        ["package/b", Buffer.alloc(4)],
      ]),
    ),
  ).toThrow("total")
  expect(() =>
    inspect(
      tarGz([
        ["a", Buffer.alloc(0)],
        ["b", Buffer.alloc(0)],
        ["c", Buffer.alloc(0)],
      ]),
    ),
  ).toThrow("entries")
  expect(() => inspect(tarGz([["package/metadata-limit", Buffer.alloc(0)]]))).toThrow("metadata")

  const inflated = createTarInspectorForTests({
    maxCompressedBytes: 2048,
    maxEntries: 2,
    maxMemberBytes: 1024,
    maxMetadataBytes: 1024,
    maxTotalContentBytes: 1024,
    maxUncompressedBytes: 1023,
  })
  expect(() => inflated(tarGz([]))).toThrow("uncompressed")
})

test("verified tar parser explicitly rejects extensions, base-256 sizes, truncation, and bad padding", () => {
  for (const type of ["x", "L"]) {
    expect(() => inspectTarGz(tarGz([["package/extension", Buffer.from("x"), type]]))).toThrow(
      "regular file",
    )
  }

  const base256 = tarGzRaw([["package/base256", Buffer.alloc(0)]])
  base256[124] = 0x80
  updateChecksum(base256.subarray(0, 512))
  expect(() => inspectTarGz(gzipSync(base256))).toThrow("octal")

  const truncated = tarGzRaw([["package/file", Buffer.from("content")]]).subarray(0, 1024)
  expect(() => inspectTarGz(gzipSync(truncated))).toThrow("terminator")

  const badPadding = tarGzRaw([["package/file", Buffer.from("x")]])
  badPadding[513] = 1
  expect(() => inspectTarGz(gzipSync(badPadding))).toThrow("padding")
})

function tarGz(entries: readonly (readonly [string, Buffer, string?])[]): Buffer {
  return gzipSync(tarGzRaw(entries))
}

function tarGzRaw(entries: readonly (readonly [string, Buffer, string?])[]): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content, type = "0"] of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, "utf8")
    writeOctal(header, 0o644, 100, 8)
    writeOctal(header, 0, 108, 8)
    writeOctal(header, 0, 116, 8)
    writeOctal(header, content.byteLength, 124, 12)
    writeOctal(header, 0, 136, 12)
    header.fill(0x20, 148, 156)
    header[156] = type.charCodeAt(0)
    header.write("ustar\0", 257, 6, "ascii")
    header.write("00", 263, 2, "ascii")
    updateChecksum(header)
    blocks.push(header, content, Buffer.alloc((512 - (content.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function updateChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156)
  let checksum = 0
  for (const byte of header) checksum += byte
  const checksumText = checksum.toString(8).padStart(6, "0")
  header.write(`${checksumText}\0 `, 148, 8, "ascii")
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0")
  buffer.write(`${text}\0`, offset, length, "ascii")
}
