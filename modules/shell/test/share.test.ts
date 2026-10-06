import { expect, test } from "bun:test"
import { LAYOUT_VERSION, serializeLayout } from "../src/layout.ts"
import { decodeLayoutHash, encodeLayoutHash, shareUrl } from "../src/share.ts"

const layout = { grid: { width: 100, root: { type: "leaf", data: ["viewer.main"] } }, panels: { "viewer.main": { title: "Map — ünïcode ✓" } } }

test("layout hash round-trips, including non-ASCII titles", () => {
  const hash = encodeLayoutHash(layout)
  expect(hash.startsWith("#layout=")).toBe(true)
  expect(hash.slice("#layout=".length)).toMatch(/^[A-Za-z0-9_-]+$/)
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
