import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { gzipSync } from "node:zlib"

export const MB = 1024 * 1024
export interface Budgets {
  /** Largest allowed single tile file (any file under a `tiles/` directory). */
  readonly tileBytes: number
  /** Total size of the built site. */
  readonly siteBytes: number
  /** Gzipped size of JS referenced by index.html at first load. */
  readonly initialJsGzBytes: number
}
export const DEFAULT_BUDGETS: Budgets = { tileBytes: 20 * MB, siteBytes: 900 * MB, initialJsGzBytes: 1.5 * MB }

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const fmt = (b: number) => `${(b / MB).toFixed(2)} MB`
const SCRIPT_RE = /<(?:script[^>]*\ssrc|link[^>]*rel=["']modulepreload["'][^>]*\shref)=["']([^"']+\.m?js)["']/g

/** Returns one message per exceeded budget; empty when the site in `dir` is within budget. */
export const checkBudgets = (dir: string, budgets: Budgets = DEFAULT_BUDGETS): string[] => {
  const errors: string[] = []
  if (!existsSync(dir)) return [`build output ${dir} does not exist`]
  const files = walk(dir)
  const total = files.reduce((n, f) => n + statSync(f).size, 0)
  if (total > budgets.siteBytes) errors.push(`site is ${fmt(total)}, over the ${fmt(budgets.siteBytes)} budget`)
  for (const f of files) {
    const rel = relative(dir, f).split(sep)
    if (rel.includes("tiles") && statSync(f).size > budgets.tileBytes)
      errors.push(`tile ${rel.join("/")} is ${fmt(statSync(f).size)}, over the ${fmt(budgets.tileBytes)} per-tile budget`)
  }
  const indexPath = join(dir, "index.html")
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8")
    const seen = new Set<string>()
    let gz = 0
    for (const m of html.matchAll(SCRIPT_RE)) {
      const src = m[1]!
      if (/^[a-z]+:|^\/\//i.test(src) || seen.has(src)) continue
      seen.add(src)
      const p = join(dir, src.replace(/^\//, ""))
      if (existsSync(p)) gz += gzipSync(readFileSync(p)).length
    }
    if (gz > budgets.initialJsGzBytes)
      errors.push(`initial JS is ${fmt(gz)} gzipped, over the ${fmt(budgets.initialJsGzBytes)} budget (lazy-load Monaco and map data)`)
  }
  return errors
}
