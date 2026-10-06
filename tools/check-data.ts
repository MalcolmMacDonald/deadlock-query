import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBudgets } from "./lib/budget.ts"
import { checkPointer, fetchData, parsePointer } from "./lib/data.ts"

/**
 * `bun tools/check-data.ts` — verify data/current-build.json: shape and naming, then download every asset, check its
 * sha256, unzip, and apply the site/tile budgets to the result. Needs no secrets (Release assets are public).
 */
if (import.meta.main) {
  const pointer = parsePointer(JSON.parse(readFileSync("data/current-build.json", "utf8")))
  const errors = checkPointer(pointer)
  if (errors.length === 0) {
    const out = mkdtempSync(join(tmpdir(), "dlq-data-"))
    try {
      await fetchData(pointer, out)
      errors.push(...checkBudgets(out))
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }
  if (errors.length) { console.error(errors.map((e) => `✗ ${e}`).join("\n")); process.exit(1) }
  console.log(`data ok: ${pointer.tag}, ${pointer.assets.length} asset(s) verified within budget`)
}
