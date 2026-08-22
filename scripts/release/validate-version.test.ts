import { expect, test } from "bun:test"

import { validateCandidateVersion } from "./validate-version.js"

test("candidate version accepts exact semver and rejects shell-shaped input", () => {
  expect(() => validateCandidateVersion("1.0.0", "1.0.0")).not.toThrow()
  for (const value of [
    "1.0.0; touch injected",
    '1.0.0"; echo injected; #',
    "$(echo injected)",
    "1.0",
    "v1.0.0",
  ]) {
    expect(() => validateCandidateVersion(value, "1.0.0")).toThrow("semantic version")
  }
  expect(() => validateCandidateVersion("1.0.1", "1.0.0")).toThrow("package version")
})
