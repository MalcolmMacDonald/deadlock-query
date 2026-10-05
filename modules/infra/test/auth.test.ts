import { expect, test } from "bun:test"
import { RateLimiter, hashPassword, readCookie, signSession, verifyPassword, verifySession } from "../src/auth.ts"

test("password hash round-trips and rejects wrong password", async () => {
  const h = await hashPassword("hunter2")
  expect(h.startsWith("pbkdf2$")).toBe(true)
  expect(await verifyPassword("hunter2", h)).toBe(true)
  expect(await verifyPassword("hunter3", h)).toBe(false)
  expect(await verifyPassword("x", "garbage")).toBe(false)
})

test("sessions verify, expire, and reject tampering", async () => {
  const now = 1_000_000_000_000
  const s = await signSession("key", now)
  expect(await verifySession("key", s, now + 1000)).toBe(true)
  expect(await verifySession("other", s, now + 1000)).toBe(false)
  expect(await verifySession("key", s, now + 13 * 3600 * 1000)).toBe(false)
  expect(await verifySession("key", s.replace(/^\d/, "9"), now)).toBe(false)
  expect(await verifySession("key", undefined)).toBe(false)
})

test("rate limiter blocks after max attempts then resets", () => {
  const r = new RateLimiter(2, 1000)
  expect([r.allow("a", 0), r.allow("a", 1), r.allow("a", 2)]).toEqual([true, true, false])
  expect(r.allow("a", 1001)).toBe(true)
  expect(r.allow("b", 2)).toBe(true)
})

test("readCookie finds the named cookie", () => {
  expect(readCookie("a=1; dlq_session=abc.def; b=2")).toBe("abc.def")
  expect(readCookie(null)).toBeUndefined()
})
