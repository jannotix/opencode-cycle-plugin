import { describe, expect, test } from "bun:test"

import { buildCycloneDxBom, type CargoMetadata, type JavaScriptPackage } from "./sbom.js"

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
