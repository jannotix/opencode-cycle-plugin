import { expect, test } from "bun:test"

import { buildCriticalResult } from "./repeat-critical-suite.js"

test("critical repeat result passes only after every required iteration", () => {
  const revision = "a".repeat(40)
  expect(
    buildCriticalResult(
      20,
      Array.from({ length: 20 }, (_, index) => ({ durationMs: index + 1 })),
      revision,
    ),
  ).toMatchObject({
    completedIterations: 20,
    passed: true,
    requestedIterations: 20,
    revision,
  })
  expect(buildCriticalResult(20, [{ durationMs: 1 }], revision).passed).toBeFalse()
  expect(() => buildCriticalResult(0, [], revision)).toThrow("positive")
  expect(() => buildCriticalResult(1, [], "not-a-revision")).toThrow("revision")
})
