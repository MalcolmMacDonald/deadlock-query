import { expect, test } from "bun:test"
import { LAYOUT_KEY, LAYOUT_VERSION, loadLayout, parseLayout, resetLayout, saveLayout, serializeLayout } from "../src/layout.ts"
import { modules } from "../src/modules.ts"

const memStore = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

test("layout round-trips through the store", () => {
  const s = memStore()
  saveLayout(s, { grid: 1 })
  expect(loadLayout(s)).toEqual({ grid: 1 })
  resetLayout(s)
  expect(loadLayout(s)).toBeNull()
})

test("corrupt, empty, or other-version data is ignored", () => {
  expect(parseLayout(null)).toBeNull()
  expect(parseLayout("not json")).toBeNull()
  expect(parseLayout("42")).toBeNull()
  expect(parseLayout(JSON.stringify({ version: LAYOUT_VERSION + 1, layout: {} }))).toBeNull()
  expect(parseLayout(serializeLayout({ a: 1 }))).toEqual({ a: 1 })
  expect(LAYOUT_KEY).toBeTruthy()
})

test("module list has unique module and panel ids", () => {
  const ids = modules.flatMap((m) => m.panels.map((p) => p.id))
  expect(new Set(ids).size).toBe(ids.length)
  expect(new Set(modules.map((m) => m.id)).size).toBe(modules.length)
})
