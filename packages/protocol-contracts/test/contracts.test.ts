import { expect, test } from "bun:test"

import { PROTOCOL_VERSION, ProtocolValidationError, parseProtocolEnvelope } from "../src/index.js"

const fixture = (name: string) =>
  Bun.file(new URL(`../../../tests/contract/protocol/${name}`, import.meta.url)).json()

test("TypeScript validates Rust and TypeScript contract fixtures", async () => {
  for (const name of ["rust-request-v1.json", "typescript-request-v1.json"]) {
    const envelope = parseProtocolEnvelope(await fixture(name))
    expect(envelope.version).toBe(PROTOCOL_VERSION)
    expect(envelope.payload.type).toBe("request")
  }
})

test("TypeScript rejects unknown protocol versions", async () => {
  const envelope = await fixture("rust-request-v1.json")
  envelope.version = 2
  expect(() => parseProtocolEnvelope(envelope)).toThrow(ProtocolValidationError)
})

test("TypeScript rejects unknown fields", async () => {
  const envelope = { ...(await fixture("typescript-request-v1.json")), unexpected: true }
  expect(() => parseProtocolEnvelope(envelope)).toThrow(ProtocolValidationError)
})
