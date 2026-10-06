import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Load budget (PLAN.md §6, M6). The package entry is what the shell fetches when it opens the editor
 * panel; it must stay a small loader that shows progress while Monaco (the large part) streams in.
 * Raising a number here is a deliberate decision: say why in STATE.md.
 */
const INITIAL_JS_BUDGET_KB = 16 // entry + everything it imports statically (measured ~7 kB minified)
const DEFERRED_JS_BUDGET_KB = 3_500 // Monaco + panel + Effect, fetched after mount starts (measured ~3.3 MB; `editor.all.js` alone would add ~250 kB)

const build = async () => {
  const outdir = mkdtempSync(join(tmpdir(), "dlq-budget-"))
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/index.ts")], target: "browser", format: "esm", minify: true, splitting: true, loader: { ".ttf": "file" }, outdir })
  expect(r.success).toBe(true)
  const files = new Map(r.outputs.filter((o) => o.path.endsWith(".js")).map((o) => [o.path.split("/").pop()!, readFileSync(o.path, "utf8")]))
  const entry = r.outputs.find((o) => o.kind === "entry-point")!.path.split("/").pop()!
  return { files, entry }
}

/** Files fetched before any dynamic `import()` runs: the entry and its static (`from "./x.js"` / `import "./x.js"`) imports. */
const initialGraph = (files: Map<string, string>, entry: string): Set<string> => {
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name) || !files.has(name)) return
    seen.add(name)
    for (const m of files.get(name)!.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) {
      // `import("./x.js")` has a paren after `import`, so it is not matched here.
      visit(m[1]!)
    }
  }
  visit(entry)
  return seen
}

test("the entry is a small loader; Monaco and the panel load afterwards", async () => {
  const { files, entry } = await build()
  const initial = initialGraph(files, entry)
  const kb = (names: Iterable<string>) => [...names].reduce((n, f) => n + files.get(f)!.length, 0) / 1024
  const initialKb = kb(initial)
  const deferredKb = kb([...files.keys()].filter((f) => !initial.has(f)))
  console.log(`query-builder JS: initial ${initialKb.toFixed(1)} kB, deferred ${deferredKb.toFixed(0)} kB`)
  expect(initialKb).toBeLessThan(INITIAL_JS_BUDGET_KB)
  expect(deferredKb).toBeLessThan(DEFERRED_JS_BUDGET_KB)
  expect(deferredKb).toBeGreaterThan(1_000) // the heavy code really is deferred (a bundler change that inlined it would fail here)
  // Nothing heavy is reachable statically.
  const initialText = [...initial].map((f) => files.get(f)!).join("\n")
  expect(initialText).not.toMatch(/monaco/i)
  expect(initialText).toContain("import(")
}, 60_000)

test("the editor entry list stays the trimmed one, not editor.all.js", async () => {
  const src = await Bun.file(join(import.meta.dir, "../src/panel/QueryEditorPanel.ts")).text()
  expect(src).not.toContain("editor.all.js")
  expect(src).toContain('./monacoContributions.ts')
})
