import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"

import {
  buildCycloneDxBom,
  collectJavaScriptInventory,
  collectPackedJavaScriptInventory,
  validateCycloneDxBom,
  type CargoMetadata,
  type JavaScriptPackage,
} from "./sbom.js"
import type { VerifiedFile } from "./verified-file.js"

describe("release SBOM", () => {
  test("includes only production-reachable Rust and JavaScript dependencies", () => {
    const cargo: CargoMetadata = {
      packages: [
        packageRecord("root", "0.1.0", "FSL-1.1-MIT"),
        packageRecord("runtime", "1.0.0", "MIT"),
        packageRecord("dev-only", "2.0.0", "MIT"),
      ],
      resolve: {
        nodes: [
          {
            deps: [
              { dep_kinds: [{ kind: null }], pkg: "runtime@1.0.0" },
              { dep_kinds: [{ kind: "dev" }], pkg: "dev-only@2.0.0" },
            ],
            id: "root@0.1.0",
          },
          { deps: [], id: "runtime@1.0.0" },
          { deps: [], id: "dev-only@2.0.0" },
        ],
        root: null,
      },
    }
    const javascript: JavaScriptPackage[] = [
      {
        dependencies: ["runtime-js@3.0.0"],
        license: "FSL-1.1-MIT",
        name: "opencode-cycle",
        version: "0.1.0",
      },
      {
        dependencies: [],
        license: "MIT",
        name: "runtime-js",
        version: "3.0.0",
      },
    ]

    const bom = buildCycloneDxBom(cargo, "root@0.1.0", javascript, ["opencode-cycle@0.1.0"], [])
    const refs = bom.components.map((component) => component["bom-ref"])

    expect(bom.specVersion).toBe("1.6")
    expect(bom.metadata.component).toEqual({
      "bom-ref": "pkg:github/jannotix/opencode-cycle-plugin",
      name: "Cycle for OpenCode",
      type: "application",
    })
    expect(refs).toContain("pkg:cargo/runtime@1.0.0")
    expect(refs).not.toContain("pkg:cargo/dev-only@2.0.0")
    expect(refs).toContain("pkg:npm/runtime-js@3.0.0")
    expect(bom.dependencies.find((entry) => entry.ref === "pkg:cargo/root@0.1.0")?.dependsOn).toEqual([
      "pkg:cargo/runtime@1.0.0",
    ])
  })

  test("binds release artifacts by SHA-256 without embedding paths", () => {
    const bom = buildCycloneDxBom(
      { packages: [packageRecord("root", "0.1.0", "MIT")], resolve: { nodes: [], root: null } },
      "root@0.1.0",
      [],
      [],
      [{ digest: "a".repeat(64), name: "plugin.tgz", size: 1 }],
    )

    const artifact = bom.components.find((component) => component.type === "file")
    expect(artifact?.name).toBe("plugin.tgz")
    expect(artifact?.hashes).toEqual([{ alg: "SHA-256", content: "a".repeat(64) }])
  })

  test("rejects an artifact inventory that differs from the release manifest allowlist", () => {
    const cargo = {
      packages: [packageRecord("root", "0.1.0", "MIT")],
      resolve: { nodes: [], root: null },
    }
    expect(() =>
      buildCycloneDxBom(
        cargo,
        "root@0.1.0",
        [],
        [],
        [{ digest: "a".repeat(64), name: "plugin.tgz", size: 1 }],
        [{ name: "plugin.tgz", sha256: "b".repeat(64), size: 1 }],
      ),
    ).toThrow("manifest artifact allowlist")
  })

  test("missing required JavaScript dependencies fail instead of disappearing from the SBOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "cycle-sbom-missing-dependency-"))
    const packageRoot = join(root, "package")
    try {
      await mkdir(packageRoot)
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          dependencies: { "missing-production-package": "1.0.0" },
          license: "MIT",
          name: "root-package",
          version: "1.0.0",
        }),
      )
      await expect(collectJavaScriptInventory(root, [packageRoot])).rejects.toThrow(
        "missing-production-package",
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("derives release package roots from verified tar manifests and cross-checks bun.lock", async () => {
    const root = resolve(import.meta.dir, "../..")
    const version = "1.0.0"
    const packed = await Promise.all(
      [
        ["opencode-cycle", `opencode-cycle-${version}.tgz`],
        ["native-linux-x64", `opencode-cycle-native-linux-x64-${version}.tgz`],
        ["native-win32-x64", `opencode-cycle-native-win32-x64-${version}.tgz`],
      ].map(async ([directory, name]) => {
        const manifest = await readFile(join(root, "packages", directory as string, "package.json"))
        return verifiedTar(name as string, manifest)
      }),
    )
    const lock = await readFile(join(root, "bun.lock"), "utf8")
    const inventory = await collectPackedJavaScriptInventory(root, packed, version, lock)
    expect(inventory.roots).toEqual([
      "@opencode-cycle/native-linux-x64@1.0.0",
      "@opencode-cycle/native-win32-x64@1.0.0",
      "opencode-cycle@1.0.0",
    ])
    expect(inventory.packages.map((item) => `${item.name}@${item.version}`)).toContain(
      "@opencode-ai/sdk@1.18.21",
    )
    const identities = inventory.packages.map((item) => `${item.name}@${item.version}`)
    expect(identities).toContain("zod@3.25.76")
    expect(identities).toContain("zod@4.1.8")
    expect(identities).toContain("string-width@7.2.0")
    expect(identities).toContain("string-width@8.2.2")
    expect(identities).toContain("msgpackr-extract@3.0.4")
    expect(identities).toContain("@msgpackr-extract/msgpackr-extract-win32-x64@3.0.4")
    expect(identities).toContain("@msgpackr-extract/msgpackr-extract-linux-x64@3.0.4")
    expect(identities).not.toContain("@msgpackr-extract/msgpackr-extract-darwin-arm64@3.0.4")
    expect(identities).not.toContain("@msgpackr-extract/msgpackr-extract-darwin-x64@3.0.4")
    expect(identities).not.toContain("@msgpackr-extract/msgpackr-extract-linux-arm@3.0.4")
    expect(identities).not.toContain("@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4")
    expect(
      inventory.packages.find((item) => `${item.name}@${item.version}` === "chromium-bidi@17.0.2")
        ?.dependencies,
    ).toContain("zod@3.25.76")
    expect(
      inventory.packages.find((item) => `${item.name}@${item.version}` === "cliui@9.0.1")
        ?.dependencies,
    ).toContain("string-width@7.2.0")
    expect(
      inventory.packages.find((item) => `${item.name}@${item.version}` === "msgpackr@2.0.5")
        ?.dependencies,
    ).toContain("msgpackr-extract@3.0.4")
    expect(
      inventory.packages.find((item) => `${item.name}@${item.version}` === "msgpackr-extract@3.0.4")
        ?.dependencies,
    ).toEqual([
      "@msgpackr-extract/msgpackr-extract-linux-x64@3.0.4",
      "@msgpackr-extract/msgpackr-extract-win32-x64@3.0.4",
      "node-gyp-build-optional-packages@5.2.2",
    ])
    expect(
      inventory.packages.find((item) => `${item.name}@${item.version}` === "chromium-bidi@17.0.2")
        ?.dependencies,
    ).toContain("devtools-protocol@0.0.1653615")

    const bom = buildCycloneDxBom(
      {
        packages: [packageRecord("root", "0.1.0", "MIT")],
        resolve: { nodes: [{ deps: [], id: "root@0.1.0" }], root: null },
      },
      "root@0.1.0",
      inventory.packages,
      inventory.roots,
      packed.map((artifact) => ({
        digest: artifact.sha256,
        name: artifact.name,
        size: artifact.size,
      })),
    )
    await expect(validateCycloneDxBom(bom)).resolves.toBeUndefined()
    expect(
      bom.components
        .filter((component) => component.purl?.startsWith("pkg:npm/"))
        .map((component) => `${component.name}@${component.version}`)
        .sort(),
    ).toEqual([...identities].sort())
    expect(
      bom.dependencies.find((entry) => entry.ref === "pkg:npm/msgpackr@2.0.5")?.dependsOn,
    ).toContain("pkg:npm/msgpackr-extract@3.0.4")
    expect(
      bom.components.filter((component) => component.type === "file").map((component) => component.name).sort(),
    ).toEqual(packed.map((artifact) => artifact.name).sort())
    expect(
      bom.components.find(
        (component) => component.purl === "pkg:npm/%40msgpackr-extract/msgpackr-extract-win32-x64@3.0.4",
      )?.type,
    ).toBe("library")

    const plugin = JSON.parse(
      await readFile(join(root, "packages", "opencode-cycle", "package.json"), "utf8"),
    ) as Record<string, unknown>
    plugin.dependencies = {
      "@opencode-ai/plugin": "1.18.21",
      "@puppeteer/browsers": "3.2.0",
      "puppeteer-core": "25.6.0",
    }
    const missingSdk = packed.map((artifact) =>
      artifact.name.startsWith("opencode-cycle-1.0.0")
        ? verifiedTar(artifact.name, Buffer.from(JSON.stringify(plugin)))
        : artifact,
    )
    await expect(collectPackedJavaScriptInventory(root, missingSdk, version, lock)).rejects.toThrow(
      "allowlist",
    )

    const missingQualified = Bun.JSONC.parse(lock) as {
      packages: Record<string, unknown>
    }
    delete missingQualified.packages["chromium-bidi/zod"]
    await expect(
      collectPackedJavaScriptInventory(root, packed, version, JSON.stringify(missingQualified)),
    ).rejects.toThrow(/zod.*bun\.lock|bun\.lock.*zod/u)

    const cyclic = Bun.JSONC.parse(lock) as {
      packages: Record<string, unknown[]>
    }
    const qualifiedZod = cyclic.packages["chromium-bidi/zod"]
    if (qualifiedZod === undefined) throw new Error("test fixture is missing chromium-bidi/zod")
    qualifiedZod[2] = { dependencies: { "chromium-bidi": "17.0.2" } }
    await expect(
      collectPackedJavaScriptInventory(root, packed, version, JSON.stringify(cyclic)),
    ).rejects.toThrow("cycle")

    const ambiguous = Bun.JSONC.parse(lock) as {
      packages: Record<string, unknown>
    }
    const rootZod = ambiguous.packages.zod
    if (rootZod === undefined) throw new Error("test fixture is missing root zod")
    delete ambiguous.packages.zod
    ambiguous.packages["other-issuer/zod"] = rootZod
    await expect(
      collectPackedJavaScriptInventory(root, packed, version, JSON.stringify(ambiguous)),
    ).rejects.toThrow("ambiguous")

    const optionalPeers = Bun.JSONC.parse(lock) as {
      packages: Record<string, unknown[]>
    }
    const optionalPeerMsgpackr = optionalPeers.packages.msgpackr
    if (optionalPeerMsgpackr === undefined) throw new Error("test fixture is missing msgpackr")
    optionalPeerMsgpackr[2] = {
      ...(optionalPeerMsgpackr[2] as object),
      optionalPeers: ["optional-peer-missing", "yaml"],
      peerDependencies: { "optional-peer-missing": "1.0.0", yaml: "^2.9.0" },
    }
    optionalPeers.packages["optional-peer-missing"] = [
      "optional-peer-missing@1.0.0",
      "",
      {},
      "sha512-test-only",
    ]
    const optionalPeerInventory = await collectPackedJavaScriptInventory(
      root,
      packed,
      version,
      JSON.stringify(optionalPeers),
    )
    expect(
      optionalPeerInventory.packages.find(
        (item) => `${item.name}@${item.version}` === "msgpackr@2.0.5",
      )?.dependencies,
    ).toContain("yaml@2.9.0")
    expect(optionalPeerInventory.packages.map((item) => `${item.name}@${item.version}`)).not.toContain(
      "optional-peer-missing@1.0.0",
    )

    const malformedOptionalPeers = Bun.JSONC.parse(lock) as {
      packages: Record<string, unknown[]>
    }
    const malformedMsgpackr = malformedOptionalPeers.packages.msgpackr
    if (malformedMsgpackr === undefined) throw new Error("test fixture is missing msgpackr")
    malformedMsgpackr[2] = {
      ...(malformedMsgpackr[2] as object),
      optionalPeers: ["not-an-encoded-peer"],
    }
    await expect(
      collectPackedJavaScriptInventory(root, packed, version, JSON.stringify(malformedOptionalPeers)),
    ).rejects.toThrow("missing from peerDependencies")

    const missingRequiredPeer = Bun.JSONC.parse(lock) as {
      packages: Record<string, unknown[]>
    }
    const requiredPeerChromium = missingRequiredPeer.packages["chromium-bidi"]
    if (requiredPeerChromium === undefined) throw new Error("test fixture is missing chromium-bidi")
    requiredPeerChromium[2] = {
      ...(requiredPeerChromium[2] as object),
      peerDependencies: {
        "devtools-protocol": "*",
        "required-peer-missing": "1.0.0",
      },
    }
    missingRequiredPeer.packages["required-peer-missing"] = [
      "required-peer-missing@1.0.0",
      "",
      {},
      "sha512-test-only",
    ]
    await expect(
      collectPackedJavaScriptInventory(root, packed, version, JSON.stringify(missingRequiredPeer)),
    ).rejects.toThrow(/required.*peer|required.*missing/iu)
  }, { timeout: 30_000 })

  test("validates generated output against the local official CycloneDX 1.6 schema", async () => {
    const bom = buildCycloneDxBom(
      { packages: [packageRecord("root", "0.1.0", "MIT")], resolve: { nodes: [], root: null } },
      "root@0.1.0",
      [],
      [],
      [],
    )
    await expect(validateCycloneDxBom(bom)).resolves.toBeUndefined()
    await expect(validateCycloneDxBom({ ...bom, specVersion: "1.5" })).rejects.toThrow(
      "CycloneDX 1.6",
    )
  })
})

function packageRecord(name: string, version: string, license: string) {
  return {
    id: `${name}@${version}`,
    license,
    name,
    source: "registry+https://github.com/rust-lang/crates.io-index",
    version,
  }
}

function verifiedTar(name: string, manifest: Buffer): VerifiedFile {
  const content = tarGz([["package/package.json", manifest]])
  return {
    content,
    name,
    path: join("C:\\verified", name),
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.byteLength,
  }
}

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
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
    blocks.push(header, content, Buffer.alloc((512 - (content.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii")
}
