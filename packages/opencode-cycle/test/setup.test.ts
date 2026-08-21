import { expect, test } from "bun:test"

import { inspectProviders, setupReport } from "../src/commands/setup.js"

test("setup inventory exposes models without provider credentials or options", () => {
  const inventory = inspectProviders({
    default: { alpha: "stable" },
    providers: [
      {
        id: "alpha",
        models: {
          preview: { id: "preview", name: "Preview", status: "beta" },
          stable: { id: "stable", name: "Stable", status: "active" },
        },
        name: "Alpha",
        source: "config",
        key: "must-not-leak",
        options: { apiKey: "must-not-leak" },
      },
    ],
  })

  expect(inventory.providers).toEqual([{ id: "alpha", name: "Alpha", source: "config" }])
  expect(JSON.stringify(inventory)).not.toContain("must-not-leak")
  expect(inventory.models.map((model) => model.id)).toEqual(["preview", "stable"])
})

test("setup inherits the active model and warns without blocking correlated review models", () => {
  const report = setupReport(
    { defaults: {}, models: [], providers: [] },
    "alpha/stable",
    "high",
    {},
    {},
  )

  expect(Object.values(report.roleModels)).toEqual([
    "alpha/stable",
    "alpha/stable",
    "alpha/stable",
    "alpha/stable",
    "alpha/stable",
  ])
  expect(report.permissionPreset).toBe("balanced")
  expect(report.activeVariant).toBe("high")
  expect(report.correlationWarning).toContain("correlated model errors")
})

test("independent reviewer assignments remove the correlation warning", () => {
  const report = setupReport(
    { defaults: {}, models: [], providers: [] },
    "alpha/stable",
    null,
    {
      arbiter: "gamma/stable",
      functional_reviewer: "alpha/stable",
      security_reviewer: "beta/stable",
    },
    { arbiter: "xhigh" },
  )

  expect(report.correlationWarning).toBeNull()
  expect(report.roleVariants).toEqual({ arbiter: "xhigh" })
})
