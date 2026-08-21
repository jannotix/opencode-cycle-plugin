import { expect, test } from "bun:test"

import { buildCriticalResult } from "./repeat-critical-suite.js"

test("critical repeat result passes only after every required iteration", () => {
  expect(buildCriticalResult(20, Array.from({ length: 20 }, (_, index) => ({ durationMs: index + 1 })))).toMatchObject({
    completedIterations: 20,
    passed: true,
    requestedIterations: 20,
  })
  expect(buildCriticalResult(20, [{ durationMs: 1 }]).passed).toBeFalse()
  expect(() => buildCriticalResult(0, [])).toThrow("positive")
})
