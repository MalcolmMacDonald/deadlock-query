import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBudgets } from "../../../tools/lib/budget.ts"

const site = () => mkdtempSync(join(tmpdir(), "dlq-budget-"))
const small = { tileBytes: 1000, siteBytes: 5000, initialJsGzBytes: 200 }

test("within budget passes", () => {
  const d = site()
  writeFileSync(join(d, "index.html"), "<h1>hi</h1>")
  expect(checkBudgets(d, small)).toEqual([])
})

test("oversized tile fails with its path", () => {
  const d = site()
  mkdirSync(join(d, "data/tiles"), { recursive: true })
  writeFileSync(join(d, "data/tiles/a.bin"), Buffer.alloc(1500))
  const [e] = checkBudgets(d, small)
  expect(e).toContain("tile data/tiles/a.bin")
})

test("oversized site fails", () => {
  const d = site()
  writeFileSync(join(d, "blob"), Buffer.alloc(6000))
  expect(checkBudgets(d, small).join()).toContain("site is")
})

test("initial JS is measured gzipped, external scripts ignored", () => {
  const d = site()
  writeFileSync(join(d, "app.js"), Buffer.from(Array.from({ length: 4000 }, () => Math.floor(Math.random() * 256))))
  writeFileSync(join(d, "index.html"), '<script type="module" src="/app.js"></script><script src="https://cdn.x/y.js"></script>')
  expect(checkBudgets(d, { ...small, siteBytes: 1e9 }).join()).toContain("initial JS")
})

test("missing output dir is an error", () => {
  expect(checkBudgets("/nonexistent-dlq")).toHaveLength(1)
})
