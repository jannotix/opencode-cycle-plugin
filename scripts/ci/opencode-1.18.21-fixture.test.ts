import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixtureRoot = fileURLToPath(new URL("./fixtures/opencode-1.18.21/", import.meta.url))
const upstreamLicense = `MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

const provenance = {
  commit: "826d9ad46a22bef0294998e08daa3c4904fea28f",
  files: {
    "packages/core/src/v1/config/plugin.ts": "b45a25d030b253b92449050538433c8ab4dd53db9d2c81228cd6133f4d94837c",
    "packages/opencode/src/config/config.ts": "b0fd57d860661ce70e7fbd06e7f2cc24417c70d3db4207ad97129ac1b649997e",
    "packages/opencode/src/config/paths.ts": "cd86a34461b27caf1042f8cba140fbbed47790c4f30cd9691f87298e8d4d4444",
    "packages/opencode/src/config/plugin.ts": "8c450d5c8fdee1811bb93788462958c7e58ea551c73e18a4173c19917c734f6e",
    "packages/opencode/src/plugin/index.ts": "47c62b7cfae891d268e6b239edb0f1c46df5cb35eb11ccfd8bd4186c156024e9",
    "packages/opencode/src/plugin/loader.ts": "a7eba2d328a36a2486b50245ad98ef0daa769d4109c9e50470d8493b0936c4c0",
    "packages/opencode/src/plugin/shared.ts": "1ada9e15915e47bbb7b16436f0018c9b86845a66e687d89d037be896b9663140",
  },
  license: {
    path: "LICENSE",
    sha256: "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b",
  },
  normalization: "none",
  repository: "https://github.com/anomalyco/opencode",
  scope: "test-only canonical copies excluded from production archives",
  tag: "v1.18.21",
} as const

test("canonical OpenCode fixture carries the exact upstream MIT license and provenance", async () => {
  const license = await readFile(join(fixtureRoot, "LICENSE"))
  expect(license.length).toBe(1_065)
  expect(license.toString("utf8")).toBe(upstreamLicense)
  expect(createHash("sha256").update(license).digest("hex")).toBe(provenance.license.sha256)
  expect(license.includes(0x0d)).toBe(false)
  expect([...license.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])

  const declared = JSON.parse(await readFile(join(fixtureRoot, "PROVENANCE.json"), "utf8"))
  expect(declared).toEqual(provenance)
})

test("canonical OpenCode provenance covers every vendored source byte", async () => {
  const actual = (await readdir(fixtureRoot, { recursive: true }))
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path.endsWith(".ts"))
    .sort()
  expect(actual).toEqual(Object.keys(provenance.files).sort())
  for (const path of actual) {
    const bytes = await readFile(join(fixtureRoot, path))
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      provenance.files[path as keyof typeof provenance.files],
    )
    expect(bytes.includes(0x0d)).toBe(false)
  }
})
