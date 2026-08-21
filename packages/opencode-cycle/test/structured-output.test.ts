import { expect, test } from "bun:test"

import { parseTerminalJson } from "../src/orchestration/structured-output.js"

test("structured output accepts raw JSON or one terminal JSON fence", () => {
  expect(parseTerminalJson('{"status":"completed"}', "Role")).toEqual({ status: "completed" })
  expect(
    parseTerminalJson('Checks passed.\n```json\n{"status":"completed"}\n```', "Role"),
  ).toEqual({ status: "completed" })
  expect(
    parseTerminalJson('Checks passed.\n{"status":"completed","summary":"Verified."}', "Role"),
  ).toEqual({ status: "completed", summary: "Verified." })
})

test("structured output rejects ambiguity and content after the receipt", () => {
  expect(() =>
    parseTerminalJson(
      '```json\n{"status":"blocked"}\n```\n```json\n{"status":"completed"}\n```',
      "Role",
    ),
  ).toThrow("one valid JSON object")
  expect(() =>
    parseTerminalJson('```json\n{"status":"completed"}\n```\nDone.', "Role"),
  ).toThrow("one valid JSON object")
})
