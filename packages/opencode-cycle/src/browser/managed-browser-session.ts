import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, win32 } from "node:path"

import type {
  Browser,
  ElementHandle,
  KeyInput,
  Page,
} from "puppeteer-core"

// @ts-expect-error The pinned runtime wrapper is bundled and typed at this boundary.
import puppeteerRuntime from "./puppeteer-runtime.js"
// @ts-expect-error The pinned browsers wrapper is bundled and typed at this boundary.
import * as browsersRuntime from "./puppeteer-browsers-runtime.js"

import {
  isLoopback,
  type BrowserCommand,
  type BrowserSessionFactory,
  type ManagedBrowserSession,
} from "./browser-manager.js"

const puppeteer = puppeteerRuntime as typeof import("puppeteer-core").default

interface ManagedBrowserFactoryOptions {
  readonly browserExecutable?: string
  readonly headless: boolean
  readonly projectDirectory: string
}

export class ManagedBrowserSessionFactory implements BrowserSessionFactory {
  readonly #options: ManagedBrowserFactoryOptions

  constructor(options: ManagedBrowserFactoryOptions) {
    this.#options = options
  }

  async create(input: {
    readonly allowedOrigins: ReadonlySet<string>
    readonly artifactDirectory: string
    readonly sessionId: string
  }): Promise<ManagedBrowserSession> {
    const installed = await orderedBrowserCandidates(
      this.#options.browserExecutable === undefined
        ? {}
        : { configured: this.#options.browserExecutable },
    )
    const identity = createHash("sha256").update(input.sessionId).digest("hex").slice(0, 16)
    const evidenceDirectory = join(input.artifactDirectory, "evidence", identity, randomUUID())
    await mkdir(evidenceDirectory, { recursive: true })
    const origins = new Set(input.allowedOrigins)
    // Each attempt gets its own profile. A browser that fails to start can
    // leave lock files behind, and reusing one directory across candidates
    // would let the first failure poison every later attempt.
    let profileDirectory = ""
    const { browser } = await launchFirstUsableBrowser(installed, async (candidate) => {
      const attemptProfile = join(input.artifactDirectory, "profiles", `${identity}-${randomUUID()}`)
      await mkdir(attemptProfile, { recursive: true })
      const launched = await puppeteer.launch({
        args: ["--disable-background-networking", "--disable-sync"],
        browser: "chrome",
        defaultViewport: { height: 900, width: 1440 },
        executablePath: candidate,
        headless: this.#options.headless,
        timeout: 15_000,
        userDataDir: attemptProfile,
      })
      profileDirectory = attemptProfile
      return launched
    })
    const page = (await browser.pages())[0] ?? (await browser.newPage())
    await page.setRequestInterception(true)
    page.on("request", async (request) => {
      const url = new URL(request.url())
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !isLoopback(url) &&
        !origins.has(url.origin)
      ) {
        await request.abort("blockedbyclient")
        return
      }
      await request.continue()
    })
    return new PuppeteerBrowserSession(
      browser,
      page,
      origins,
      evidenceDirectory,
      profileDirectory,
      this.#options.projectDirectory,
    )
  }
}

class PuppeteerBrowserSession implements ManagedBrowserSession {
  readonly #actions: unknown[] = []
  readonly #browser: Browser
  readonly #evidenceDirectory: string
  readonly #logs: unknown[] = []
  readonly #origins: Set<string>
  readonly #page: Page
  readonly #profileDirectory: string
  readonly #projectDirectory: string
  readonly #redactions = new Set<string>()
  #closed = false

  constructor(
    browser: Browser,
    page: Page,
    origins: Set<string>,
    evidenceDirectory: string,
    profileDirectory: string,
    projectDirectory: string,
  ) {
    this.#browser = browser
    this.#page = page
    this.#origins = origins
    this.#evidenceDirectory = evidenceDirectory
    this.#profileDirectory = profileDirectory
    this.#projectDirectory = resolve(projectDirectory)
    page.on("console", (message) => this.#recordLog("console", message.type(), message.text()))
    page.on("pageerror", (error) =>
      this.#recordLog(
        "pageerror",
        "error",
        error instanceof Error ? error.message : String(error),
      ),
    )
    page.on("requestfailed", (request) =>
      this.#recordLog(
        "requestfailed",
        "error",
        `${safeUrl(request.url())} ${request.failure()?.errorText ?? "unknown failure"}`,
      ),
    )
  }

  allowOrigin(origin: string): void {
    this.#origins.add(origin)
  }

  async execute(command: BrowserCommand): Promise<unknown> {
    if (this.#closed) throw new Error("Managed browser session is closed")
    let result: unknown
    switch (command.operation) {
      case "open":
        await this.#page.goto(required(command.url, "Browser open requires url"), {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        })
        result = await this.#pageState()
        break
      case "snapshot": {
        const snapshot = await this.#page.accessibility.snapshot({ includeIframes: true })
        result = {
          ...(await this.#pageState()),
          snapshot: this.#redact(truncate(JSON.stringify(snapshot, null, 2))),
        }
        break
      }
      case "click":
        await (await target(this.#page, command)).click()
        result = { action: "click", ...(await this.#pageState()) }
        break
      case "fill": {
        const value = fillValue(command)
        if (value) this.#redactions.add(value)
        await fillElement(await target(this.#page, command), value)
        result = { action: "fill", filled: true, ...(await this.#pageState()) }
        break
      }
      case "press": {
        const key = required(command.key, "Browser press requires key")
        const element = await optionalTarget(this.#page, command)
        if (element === undefined) await this.#page.keyboard.press(key as KeyInput)
        else await element.press(key as KeyInput)
        result = { action: "press", key, ...(await this.#pageState()) }
        break
      }
      case "upload": {
        const path = await this.#uploadPath(required(command.path, "Browser upload requires path"))
        await ((await target(this.#page, command)) as ElementHandle<HTMLInputElement>).uploadFile(path)
        result = { action: "upload", file: relative(this.#projectDirectory, path) }
        break
      }
      case "check":
        result = await this.#check(command)
        break
      case "screenshot":
        result = await this.#screenshot(command.fullPage ?? true)
        break
      case "logs":
        result = { entries: this.#logs, total: this.#logs.length }
        break
      case "close":
        throw new Error("Browser close must be handled by the manager")
    }
    this.#actions.push({
      digest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      operation: command.operation,
      timestamp: new Date().toISOString(),
      url: safeUrl(this.#page.url()),
    })
    return result
  }

  async close(): Promise<unknown> {
    if (this.#closed) return { status: "closed" }
    this.#closed = true
    const receiptPath = join(this.#evidenceDirectory, "session.json")
    const url = safeUrl(this.#page.url())
    try {
      await this.#browser.close()
      const result = { status: "closed" }
      this.#actions.push({
        digest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
        operation: "close",
        timestamp: new Date().toISOString(),
        url,
      })
      await writeFile(
        receiptPath,
        `${JSON.stringify({ actions: this.#actions, logs: this.#logs }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      )
    } finally {
      await rm(this.#profileDirectory, { force: true, recursive: true })
    }
    return { receiptDigest: await fileDigest(receiptPath), receiptPath, status: "closed" }
  }

  async #check(command: BrowserCommand): Promise<unknown> {
    const assertions: Record<string, boolean> = {}
    if (command.expectedUrl !== undefined) {
      assertions.url = command.exact === true
        ? this.#page.url() === command.expectedUrl
        : this.#page.url().includes(command.expectedUrl)
    }
    const element = await optionalTarget(this.#page, command)
    if (element !== undefined) assertions.visible = await visible(element)
    if (command.expectedText !== undefined) {
      const actual = this.#redact(
        element === undefined
          ? await this.#page.$eval("body", (body) => (body as HTMLElement).innerText)
          : await element.evaluate((node) => node.innerText),
      )
      assertions.text = command.exact === true
        ? actual.trim() === command.expectedText
        : actual.includes(command.expectedText)
    }
    if (Object.keys(assertions).length === 0) {
      throw new Error("Browser check requires a target, expectedText or expectedUrl")
    }
    const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name)
    if (failed.length > 0) throw new Error(`Browser check failed: ${failed.join(", ")}`)
    return { assertions, status: "passed", ...(await this.#pageState()) }
  }

  async #pageState(): Promise<{ readonly title: string; readonly url: string }> {
    return { title: this.#redact(await this.#page.title()), url: safeUrl(this.#page.url()) }
  }

  async #screenshot(fullPage: boolean): Promise<unknown> {
    const path = join(this.#evidenceDirectory, `screenshot-${Date.now()}-${randomUUID()}.png`)
    await this.#page.screenshot({ fullPage, path, type: "png" })
    return { fullPage, path, sha256: await fileDigest(path) }
  }

  async #uploadPath(value: string): Promise<string> {
    const path = resolve(this.#projectDirectory, value)
    const scoped = relative(this.#projectDirectory, path)
    if (isAbsolute(scoped) || scoped === ".." || scoped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("Browser upload path escapes the project directory")
    }
    await access(path)
    return path
  }

  #recordLog(source: string, level: string, message: string): void {
    if (this.#logs.length === 200) this.#logs.shift()
    this.#logs.push({ level, message: this.#redact(truncate(message, 4_096)), source })
  }

  #redact(value: string): string {
    let redacted = value
    for (const secret of this.#redactions) redacted = redacted.replaceAll(secret, "[REDACTED]")
    return redacted
  }
}

async function target(page: Page, command: BrowserCommand): Promise<ElementHandle<HTMLElement>> {
  const element = await optionalTarget(page, command)
  if (element === undefined) {
    throw new Error("Browser action requires selector, role, name, testId or text")
  }
  return element
}

async function optionalTarget(
  page: Page,
  command: BrowserCommand,
): Promise<ElementHandle<HTMLElement> | undefined> {
  const selector = selectorFor(command)
  if (selector === undefined && !hasSemanticTarget(command)) return undefined
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const element = selector === undefined
      ? await semanticTarget(page, command)
      : ((await page.$(selector)) as ElementHandle<HTMLElement> | null)
    if (element !== null) {
      if (await visible(element)) return element
      await element.dispose()
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Browser target was not found within 15000ms")
}

function selectorFor(command: BrowserCommand): string | undefined {
  if (command.testId !== undefined) {
    return `[data-testid="${escapeAttribute(command.testId)}"]`
  }
  return command.selector
}

function hasSemanticTarget(command: BrowserCommand): boolean {
  return command.role !== undefined || command.name !== undefined || command.text !== undefined
}

async function visible(element: ElementHandle<HTMLElement>): Promise<boolean> {
  return element.evaluate((node) => {
    if (!(node instanceof Element)) return false
    const style = getComputedStyle(node)
    const bounds = node.getBoundingClientRect()
    return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0
  })
}

async function semanticTarget(
  page: Page,
  command: BrowserCommand,
): Promise<ElementHandle<HTMLElement> | null> {
  const handle = await page.evaluateHandle(
    ({ exact, name, role, text }) => {
      const normalized = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/gu, " ").trim()
      const matches = (actual: string, expected: string): boolean =>
        exact === true
          ? normalized(actual) === normalized(expected)
          : normalized(actual).includes(normalized(expected))
      const implicitRole = (element: Element): string => {
        const explicit = element.getAttribute("role")
        if (explicit) return explicit
        const tag = element.tagName.toLowerCase()
        if (/^h[1-6]$/u.test(tag)) return "heading"
        if (tag === "button") return "button"
        if (tag === "a" && element.hasAttribute("href")) return "link"
        if (tag === "textarea") return "textbox"
        if (tag === "select") return "combobox"
        if (tag === "input") {
          const type = (element.getAttribute("type") ?? "text").toLowerCase()
          if (type === "checkbox") return "checkbox"
          if (type === "radio") return "radio"
          if (["button", "reset", "submit"].includes(type)) return "button"
          if (!["hidden", "file", "image", "range", "color"].includes(type)) return "textbox"
        }
        return ""
      }
      const accessibleName = (element: Element): string => {
        const labelledBy = element.getAttribute("aria-labelledby")
        if (labelledBy) {
          const value = labelledBy
            .split(/\s+/u)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
          if (normalized(value)) return normalized(value)
        }
        const aria = element.getAttribute("aria-label")
        if (aria) return normalized(aria)
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const labels = [...(element.labels ?? [])].map((item) => item.textContent ?? "").join(" ")
          if (normalized(labels)) return normalized(labels)
          if (element.placeholder) return normalized(element.placeholder)
          if (
            element instanceof HTMLInputElement &&
            ["button", "reset", "submit"].includes(element.type)
          ) {
            return normalized(element.value)
          }
        }
        return normalized(
          element.getAttribute("alt") ?? element.getAttribute("title") ?? element.textContent,
        )
      }
      return (
        [...document.querySelectorAll("body *")].find((element) => {
          if (role !== undefined && implicitRole(element) !== role) return false
          if (name !== undefined && !matches(accessibleName(element), name)) return false
          if (text !== undefined && !matches(element.textContent ?? "", text)) return false
          return true
        }) ?? null
      )
    },
    {
      exact: command.exact,
      name: command.name,
      role: command.role,
      text: command.text,
    },
  )
  const element = handle.asElement()
  if (element === null) {
    await handle.dispose()
    return null
  }
  return element as ElementHandle<HTMLElement>
}

async function fillElement(element: ElementHandle<HTMLElement>, value: string): Promise<void> {
  await element.evaluate((node, text) => {
    node.focus()
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.value = text
    } else if (node instanceof HTMLSelectElement) {
      node.value = text
    } else if (node.isContentEditable) {
      node.textContent = text
    } else {
      throw new Error("Browser fill target is not editable")
    }
    node.dispatchEvent(new Event("input", { bubbles: true }))
    node.dispatchEvent(new Event("change", { bubbles: true }))
  }, value)
}

function escapeAttribute(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function fillValue(command: BrowserCommand): string {
  if ((command.value === undefined) === (command.environmentVariable === undefined)) {
    throw new Error("Browser fill requires exactly one of value or environmentVariable")
  }
  if (command.environmentVariable === undefined) return command.value as string
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(command.environmentVariable)) {
    throw new Error("Browser credential environment variable name is invalid")
  }
  const value = process.env[command.environmentVariable]
  if (value === undefined) throw new Error("Browser credential environment variable is not set")
  return value
}

export async function resolveBrowserExecutable(configured?: string): Promise<string> {
  const candidates = await installedBrowserExecutables(configured)
  const first = candidates[0]
  if (first !== undefined) return first
  throw new Error(
    configured === undefined
      ? "No supported stable Chrome, Edge or Chromium installation was found"
      : "Configured browser executable does not exist",
  )
}

/**
 * Browsers already present in the managed cache.
 *
 * Only browsers that are already installed are considered. The pinned runtime
 * wrapper deliberately does not expose the installer, so this path can never
 * download or execute something new; it reuses what the toolchain has already
 * placed on this machine.
 */
export async function managedBrowserExecutables(): Promise<string[]> {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer")
  try {
    const installed = await browsersRuntime.getInstalledBrowsers({ cacheDir })
    return installed
      .filter((entry: { browser: string }) => entry.browser === "chrome")
      .map((entry: { executablePath: string }) => entry.executablePath)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/**
 * Candidates in the order they should be attempted.
 *
 * An explicitly configured executable wins outright. Otherwise the browsers
 * installed on the system come first, so a machine with a working browser
 * behaves exactly as before, and the managed cache is consulted only when none
 * of them can be driven.
 */
export async function orderedBrowserCandidates(input: {
  readonly configured?: string
  readonly installed?: () => Promise<string[]>
  readonly managed?: () => Promise<string[]>
} = {}): Promise<string[]> {
  if (input.configured !== undefined) return [input.configured]
  const installed = await (input.installed ?? (() => installedBrowserExecutables()))()
  const managed = await (input.managed ?? managedBrowserExecutables)()
  return [...installed, ...managed.filter((path) => !installed.includes(path))]
}

/** Every candidate that exists on disk, in preference order. */
export async function installedBrowserExecutables(configured?: string): Promise<string[]> {
  const candidates = configured === undefined
    ? browserCandidates(process.platform, process.env)
    : [configured]
  const installed: string[] = []
  for (const candidate of candidates) {
    try {
      await access(candidate)
      installed.push(candidate)
    } catch {}
  }
  return installed
}

/**
 * Launch the first candidate that actually works.
 *
 * Existing on disk does not make a browser usable: on Windows the Edge path can
 * hold a launcher stub that spawns the real process and exits zero, which the
 * automation library reports only as an opaque launch failure. Committing to
 * the first path that exists leaves managed browser QA permanently broken on
 * such a machine, so a candidate that cannot launch yields to the next one.
 *
 * Failures name the executable, never its directory, because this error
 * reaches users and agent output.
 */
export async function launchFirstUsableBrowser<T>(
  candidates: readonly string[],
  launch: (executablePath: string) => Promise<T>,
): Promise<{ browser: T; executablePath: string }> {
  const tried: string[] = []
  for (const candidate of candidates) {
    try {
      return { browser: await launch(candidate), executablePath: candidate }
    } catch {
      tried.push(basename(candidate))
    }
  }
  throw new Error(
    tried.length === 0
      ? "No supported stable Chrome, Edge or Chromium installation was found"
      : `No installed browser could be launched: tried ${tried.join(", ")}`,
  )
}

export function browserCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  // The requested platform decides the separator, not the host: a Linux
  // certification lane asking for the Windows order must get Windows paths.
  if (platform === "win32") {
    return [
      environment.PROGRAMFILES && win32.join(environment.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
      environment["PROGRAMFILES(X86)"] && win32.join(environment["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      environment.LOCALAPPDATA && win32.join(environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      environment.PROGRAMFILES && win32.join(environment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter((value): value is string => Boolean(value))
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return "about:blank"
  }
}

function truncate(value: string, maximum = 60_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[TRUNCATED]`
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}
