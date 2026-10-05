import { expect, test } from "bun:test"
import { type CacheLike, type KvLike, kvCache, RateLimiter, hashPassword, readCookie, signSession, verifyPassword, verifySession } from "../src/auth.ts"

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

const fakeCache = (): CacheLike => {
  const m = new Map<string, string>()
  return {
    match: async (k) => (m.has(k) ? new Response(m.get(k)) : undefined),
    put: async (k, r) => { m.set(k, await r.text()) },
  }
}

test("rate limiter blocks after max attempts then resets", async () => {
  const r = new RateLimiter(fakeCache(), 2, 1000)
  expect([await r.allow("a", 0), await r.allow("a", 1), await r.allow("a", 2)]).toEqual([true, true, false])
  expect(await r.allow("a", 1001)).toBe(true)
  expect(await r.allow("b", 2)).toBe(true)
})

test("rate limiter works through a KV adapter with a 60 s minimum TTL", async () => {
  const store = new Map<string, { v: string; ttl?: number }>()
  const kv: KvLike = {
    get: async (k) => store.get(k)?.v ?? null,
    put: async (k, v, o) => { store.set(k, { v, ...(o?.expirationTtl !== undefined ? { ttl: o.expirationTtl } : {}) }) },
  }
  const r = new RateLimiter(kvCache(kv), 2, 1000)
  expect([await r.allow("a", 0), await r.allow("a", 1), await r.allow("a", 2)]).toEqual([true, true, false])
  expect([...store.values()].every((e) => (e.ttl ?? 0) >= 60)).toBe(true)
})

test("readCookie finds the named cookie", () => {
  expect(readCookie("a=1; dlq_session=abc.def; b=2")).toBe("abc.def")
  expect(readCookie(null)).toBeUndefined()
})
