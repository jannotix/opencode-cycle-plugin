import { expect, test } from "bun:test"
import { gzipSync } from "node:zlib"

import { inspectTarGz } from "./tar-archive.js"

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
  const corrupt = tarGz([["package/package.json", Buffer.from("{}")]])
  corrupt[20] = (corrupt[20] as number) ^ 1
  expect(() => inspectTarGz(corrupt)).toThrow()
})

function tarGz(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content] of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, "utf8")
    writeOctal(header, 0o644, 100, 8)
    writeOctal(header, 0, 108, 8)
    writeOctal(header, 0, 116, 8)
    writeOctal(header, content.byteLength, 124, 12)
    writeOctal(header, 0, 136, 12)
    header.fill(0x20, 148, 156)
    header[156] = "0".charCodeAt(0)
    header.write("ustar\0", 257, 6, "ascii")
    header.write("00", 263, 2, "ascii")
    let checksum = 0
    for (const byte of header) checksum += byte
    const checksumText = checksum.toString(8).padStart(6, "0")
    header.write(`${checksumText}\0 `, 148, 8, "ascii")
    blocks.push(header, content, Buffer.alloc((512 - (content.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0")
  buffer.write(`${text}\0`, offset, length, "ascii")
}
