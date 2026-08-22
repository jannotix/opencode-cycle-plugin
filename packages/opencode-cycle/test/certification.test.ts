import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildDesktopActivationMarker,
  certificationBindingFromOptions,
  parseDesktopActivationMarker,
  writeDesktopActivationMarker,
} from "../src/certification.js"

const revision = "a".repeat(40)
const nonce = "b".repeat(64)
const pluginPackageSha256 = "c".repeat(64)
const nativePackageSha256 = "d".repeat(64)

const health = {
  product_version: "1.0.0",
  protocol_version: 1,
  schema_mode: "read_write" as const,
  schema_version: 17,
}

test("certification binding requires matching isolated environment authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-binding-"))
  try {
    const value = {
      nativePackageSha256,
      nonce,
      pluginPackageSha256,
      revision,
      root,
      startedAtUnixMillis: 1_700_000_000_000,
    }
    expect(
      certificationBindingFromOptions(
        { certification: value },
        { CYCLE_CERTIFICATION_NONCE: nonce, CYCLE_CERTIFICATION_ROOT: root },
      ),
    ).toEqual(value)
    expect(() =>
      certificationBindingFromOptions(
        { certification: value },
        { CYCLE_CERTIFICATION_NONCE: "e".repeat(64), CYCLE_CERTIFICATION_ROOT: root },
      ),
    ).toThrow("nonce")
    expect(() =>
      certificationBindingFromOptions(
        { certification: value },
        { CYCLE_CERTIFICATION_NONCE: nonce, CYCLE_CERTIFICATION_ROOT: join(root, "other") },
      ),
    ).toThrow("root")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("Desktop-loaded health produces one strict nonce and package-bound activation marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "cycle-cert-marker-"))
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root,
    startedAtUnixMillis: 1_700_000_000_000,
  }
  try {
    const marker = buildDesktopActivationMarker(binding, health, 1_700_000_000_100)
    expect(parseDesktopActivationMarker(marker)).toEqual(marker)
    await writeDesktopActivationMarker(binding, health, () => 1_700_000_000_100)
    expect(
      parseDesktopActivationMarker(
        JSON.parse(await readFile(join(root, "desktop-activation.json"), "utf8")) as unknown,
      ),
    ).toEqual(marker)
    await expect(
      writeDesktopActivationMarker(binding, health, () => 1_700_000_000_101),
    ).resolves.toEqual(marker)
    await expect(
      writeDesktopActivationMarker(
        { ...binding, nonce: "e".repeat(64) },
        health,
        () => 1_700_000_000_101,
      ),
    ).rejects.toThrow("another binding")
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("activation marker rejects missing or non-candidate Desktop health", () => {
  const binding = {
    nativePackageSha256,
    nonce,
    pluginPackageSha256,
    revision,
    root: "C:\\isolated",
    startedAtUnixMillis: 1_700_000_000_000,
  }
  for (const invalid of [
    { ...health, product_version: "9.9.9" },
    { ...health, protocol_version: 2 },
    { ...health, schema_mode: "safe_read_only" },
    { ...health, schema_version: 18 },
  ]) {
    expect(() => buildDesktopActivationMarker(binding, invalid as never, 1_700_000_000_100)).toThrow(
      "health",
    )
  }
})
