import { expect, test } from "bun:test"
import { LAYOUT_VERSION, serializeLayout } from "../src/layout.ts"
import { decodeLayoutHash, encodeLayoutHash, shareUrl } from "../src/share.ts"

const layout = { grid: { width: 100, root: { type: "leaf", data: ["viewer.main"] } }, panels: { "viewer.main": { title: "Map — ünïcode ✓" } } }

test("layout hash round-trips, including non-ASCII titles", () => {
  const hash = encodeLayoutHash(layout)
  expect(hash.startsWith("#layout=")).toBe(true)
  expect(hash.slice("#layout=".length)).toMatch(/^z\.[A-Za-z0-9_-]+$/)
  expect(decodeLayoutHash(hash)).toEqual(layout)
})

test("decode ignores absent, malformed, and other-version hashes", () => {
  expect(decodeLayoutHash("")).toBeNull()
  expect(decodeLayoutHash("#/")).toBeNull()
  expect(decodeLayoutHash("#layout=")).toBeNull()
  expect(decodeLayoutHash("#layout=%%%")).toBeNull()
  expect(decodeLayoutHash("#layout=bm90IGpzb24")).toBeNull()
  const other = serializeLayout(layout).replace(`"version":${LAYOUT_VERSION}`, `"version":${LAYOUT_VERSION + 1}`)
  const b64 = Buffer.from(other).toString("base64url")
  expect(decodeLayoutHash(`#layout=${b64}`)).toBeNull()
})

test("shareUrl replaces any existing hash and keeps path and query", () => {
  const url = shareUrl("https://x.test/app/?demoFailure#old", layout)
  expect(url.startsWith("https://x.test/app/?demoFailure#layout=")).toBe(true)
  expect(decodeLayoutHash(new URL(url).hash)).toEqual(layout)
})

test("withoutLayoutParam drops only the layout parameter", async () => {
  const { withoutLayoutParam } = await import("../src/share.ts")
  expect(withoutLayoutParam("#layout=abc")).toBe("")
  expect(withoutLayoutParam("")).toBe("")
  expect(withoutLayoutParam("#q=xyz&api=0.1.0&layout=abc")).toBe("#q=xyz&api=0.1.0")
  expect(withoutLayoutParam("#q=xyz")).toBe("#q=xyz")
})

test("compressed links are shorter than plain ones, and plain links from older builds still decode", () => {
  const big = { grid: {}, panels: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, { title: "Some panel title", params: { a: 1 } }])) }
  const plain = Buffer.from(serializeLayout(big)).toString("base64url")
  expect(encodeLayoutHash(big).length).toBeLessThan(plain.length / 2)
  expect(decodeLayoutHash(`#layout=${plain}`)).toEqual(big)
})
