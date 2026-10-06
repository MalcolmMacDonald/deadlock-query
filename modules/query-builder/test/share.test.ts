import { expect, test } from "bun:test"
import { MAX_SHARED_SOURCE_BYTES, checkApiVersion, decodeShare, encodeShare } from "../src/share/shareLink.ts"

test("a query survives the round trip, including unicode and long sources", async () => {
  for (const source of ["map.guardians.count()", "// naïve — 日本語 🎯\nmap.healingOrbs.select((o) => o.id).toArray()\n", "x".repeat(50_000)]) {
    const frag = await encodeShare({ source, apiVersion: "0.1.0" })
    expect(frag).toMatch(/^q=[A-Za-z0-9_-]+&api=0\.1\.0$/)
    expect(await decodeShare(`#${frag}`)).toEqual({ source, apiVersion: "0.1.0" })
  }
})

test("fragments are compressed and URL-safe", async () => {
  const source = "map.guardians.select((g) => g.id).toArray()\n".repeat(200)
  const frag = await encodeShare({ source })
  expect(frag.length).toBeLessThan(source.length / 10)
  expect(frag.slice(2)).not.toMatch(/[+/=]/)
  expect(await decodeShare(frag)).toEqual({ source })
})

test("a fragment without a query is not an error", async () => {
  expect(await decodeShare("")).toBeUndefined()
  expect(await decodeShare("#view=map&x=1")).toBeUndefined()
})

test("damaged or hostile fragments fail with a readable message", async () => {
  await expect(decodeShare("#q=%%%not-base64")).rejects.toThrow(/damaged/)
  await expect(decodeShare("#q=AAAA")).rejects.toThrow(/damaged/)
  // A few KB of compressed zeros inflate to far more than the cap: refused without materialising it.
  const bomb = await encodeShare({ source: "0".repeat(MAX_SHARED_SOURCE_BYTES * 20) })
  expect(bomb.length).toBeLessThan(20_000)
  await expect(decodeShare(bomb)).rejects.toThrow(/too large/)
})

test("a decoded link is only data: nothing in it can run", async () => {
  const shared = await decodeShare(await encodeShare({ source: "while (true) {}" }))
  expect(shared).toEqual({ source: "while (true) {}" })
})

// M5 acceptance: a stale apiVersion shows a warning.
test("apiVersion comparison warns unless the versions match", () => {
  expect(checkApiVersion("0.1.0", "0.1.0")).toEqual({ kind: "same" })
  expect(checkApiVersion("0.1.0", "0.2.0")).toMatchObject({ kind: "older", message: expect.stringContaining("older library (0.1.0; loaded 0.2.0)") })
  expect(checkApiVersion("0.3.1", "0.2.0")).toMatchObject({ kind: "newer" })
  expect(checkApiVersion("0.2.5", "0.2.1")).toMatchObject({ kind: "newer" })
  expect(checkApiVersion("1.0.0", "2.0.0")).toMatchObject({ kind: "incompatible", message: expect.stringContaining("major") })
  expect(checkApiVersion(undefined, "0.1.0")).toMatchObject({ kind: "unknown" })
  expect(checkApiVersion("banana", "0.1.0")).toMatchObject({ kind: "unknown" })
})
