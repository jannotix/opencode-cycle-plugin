import { expect, test } from "bun:test"

import { licenseExpressionAllowed } from "./check-licenses.js"

test("license policy evaluates SPDX choices instead of matching substrings", () => {
  expect(licenseExpressionAllowed("MIT OR LGPL-2.1-or-later")).toBeTrue()
  expect(licenseExpressionAllowed("(MIT OR Apache-2.0) AND Unicode-3.0")).toBeTrue()
  expect(licenseExpressionAllowed("Apache-2.0 WITH LLVM-exception OR MIT")).toBeTrue()
  expect(licenseExpressionAllowed("GPL-3.0-only AND MIT")).toBeFalse()
  expect(licenseExpressionAllowed("MIT-fake")).toBeFalse()
  expect(licenseExpressionAllowed("MIT OR")).toBeFalse()
})
