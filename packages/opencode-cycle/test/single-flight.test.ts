import { expect, test } from "bun:test"

import { SingleFlight } from "../src/single-flight.js"

test("single flight shares one workflow recovery and admits a later retry", async () => {
  const flights = new SingleFlight<number>()
  let executions = 0
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const operation = async () => {
    executions += 1
    await pending
    return executions
  }

  const first = flights.run("workflow", operation)
  const duplicate = flights.run("workflow", operation)
  expect(first).toBe(duplicate)
  expect(executions).toBe(0)

  release?.()
  expect(await first).toBe(1)
  expect(await duplicate).toBe(1)
  expect(await flights.run("workflow", operation)).toBe(2)
})

test("single flight releases a failed workflow recovery", async () => {
  const flights = new SingleFlight<number>()
  let executions = 0
  const failure = flights.run("workflow", async () => {
    executions += 1
    throw new Error("failed")
  })

  await expect(failure).rejects.toThrow("failed")
  expect(await flights.run("workflow", async () => ++executions)).toBe(2)
})
