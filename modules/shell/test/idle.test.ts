import { expect, test } from "bun:test"
import { whenIdle } from "../src/idle.ts"

test("uses requestIdleCallback with a timeout when present", () => {
  let seen: { timeout: number } | undefined
  let ran = 0
  whenIdle(() => { ran++ }, { requestIdleCallback: (cb, o) => { seen = o; cb() }, setTimeout: () => { throw new Error("unused") } })
  expect(ran).toBe(1)
  expect(seen).toEqual({ timeout: 5000 })
})

test("falls back to a timer", () => {
  let delay = 0
  whenIdle(() => {}, { setTimeout: (_cb, ms) => { delay = ms } })
  expect(delay).toBe(1500)
})
