import { expect, test } from "bun:test"
import { installGlobalErrorToasts } from "../src/errors.ts"
import { createToastStore, toastDuration } from "../src/toasts.ts"

test("toasts stack newest last, dismiss by id, and keep at most max", () => {
  const s = createToastStore(3)
  const a = s.push("info", "a")
  s.push("success", "b")
  s.push("error", "c")
  s.push("info", "d")
  expect(s.list().map((t) => t.message)).toEqual(["b", "c", "d"])
  s.dismiss(a) // already evicted: no-op
  s.dismiss(s.list()[0]!.id)
  expect(s.list().map((t) => t.message)).toEqual(["c", "d"])
})

test("identical toasts collapse into a count instead of stacking", () => {
  const s = createToastStore()
  const first = s.push("error", "boom")
  expect(s.push("error", "boom")).toBe(first)
  s.push("error", "boom")
  expect(s.list()).toHaveLength(1)
  expect(s.list()[0]!.count).toBe(3)
  s.push("info", "boom") // a different kind is a different toast
  expect(s.list()).toHaveLength(2)
})

test("subscribers hear every change until they unsubscribe", () => {
  const s = createToastStore()
  let n = 0
  const off = s.subscribe(() => n++)
  s.push("info", "x")
  s.dismiss(s.list()[0]!.id)
  off()
  s.push("info", "y")
  expect(n).toBe(2)
})

test("errors stay longer than other toasts", () => {
  expect(toastDuration("error")).toBeGreaterThan(toastDuration("info"))
})

test("global handlers turn uncaught errors and rejections into error toasts, skipping ResizeObserver noise", () => {
  const target = new EventTarget() as unknown as Pick<Window, "addEventListener" | "removeEventListener">
  const seen: Array<[string, string]> = []
  const off = installGlobalErrorToasts(target, (kind, message) => void seen.push([kind, message]))
  const fire = (type: string, props: object) => (target as unknown as EventTarget).dispatchEvent(Object.assign(new Event(type), props))
  fire("error", { error: new Error("kaboom"), message: "kaboom" })
  fire("unhandledrejection", { reason: "plain string" })
  fire("unhandledrejection", { reason: { weird: true } })
  fire("error", { message: "ResizeObserver loop completed with undelivered notifications." })
  expect(seen).toEqual([
    ["error", "Unexpected error: kaboom"],
    ["error", "Unexpected error: plain string"],
    ["error", "Unexpected error: An unexpected error occurred."],
  ])
  off()
  fire("error", { error: new Error("after") })
  expect(seen).toHaveLength(3)
})
