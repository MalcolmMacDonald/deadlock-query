import { expect, test } from "bun:test"
import { hashPassword, readCookie, signSession, verifyPassword, verifySession } from "../src/auth.ts"

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

test("readCookie finds the named cookie", () => {
  expect(readCookie("a=1; dlq_session=abc.def; b=2")).toBe("abc.def")
  expect(readCookie(null)).toBeUndefined()
})
