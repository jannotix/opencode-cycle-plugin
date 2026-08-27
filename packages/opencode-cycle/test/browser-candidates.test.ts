import { expect, test } from "bun:test"

import {
  browserCandidates,
  launchFirstUsableBrowser,
} from "../src/browser/managed-browser-session.js"

test("a browser that cannot launch is skipped for the next candidate", async () => {
  const attempted: string[] = []
  // The first candidate exists and still cannot drive a session: on Windows the
  // Edge path can hold a launcher stub that spawns the real process and exits
  // zero, which a browser automation library reports as an opaque launch
  // failure. Existing on disk is not the same as being usable.
  const result = await launchFirstUsableBrowser(
    ["/stub/msedge.exe", "/real/chrome.exe"],
    async (executablePath) => {
      attempted.push(executablePath)
      if (executablePath === "/stub/msedge.exe") throw new Error("Code: 0")
      return { name: "browser" }
    },
  )

  expect(attempted).toEqual(["/stub/msedge.exe", "/real/chrome.exe"])
  expect(result.executablePath).toBe("/real/chrome.exe")
})

test("exhausting every candidate reports what was tried without leaking paths", async () => {
  const attempt = launchFirstUsableBrowser(
    ["/one/msedge.exe", "/two/chrome.exe"],
    async () => { throw new Error("Code: 0") },
  )

  await expect(attempt).rejects.toThrow(/msedge\.exe/u)
  // Operator directories must not reach an error a user or an agent may see.
  await expect(attempt).rejects.not.toThrow(/\/one\/|\/two\//u)
})

test("no installed browser at all is reported as such", async () => {
  await expect(launchFirstUsableBrowser([], async () => ({}))).rejects.toThrow(
    "No supported stable Chrome, Edge or Chromium installation was found",
  )
})

test("Windows still prefers Edge, then Chrome", () => {
  const candidates = browserCandidates("win32", {
    LOCALAPPDATA: "C:\local",
    PROGRAMFILES: "C:\pf",
    "PROGRAMFILES(X86)": "C:\pf86",
  })
  expect(candidates.map((path) => path.split("\\").slice(-3).join("/"))).toEqual([
    "Edge/Application/msedge.exe",
    "Edge/Application/msedge.exe",
    "Chrome/Application/chrome.exe",
    "Chrome/Application/chrome.exe",
  ])
})
