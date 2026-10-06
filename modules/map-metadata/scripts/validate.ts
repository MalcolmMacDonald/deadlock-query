import { readFileSync } from "node:fs"
import type { Manifest } from "@deadlock-query/contracts"
import type { ValidationContext } from "../src/context.ts"
import { checkPath } from "../src/dataDir.ts"

/**
 * `bun run metadata:validate -- <file|dir>... [--manifest manifest.json] [--json]`
 * A directory is a build directory (`data/metadata/<gameBuildId>/`) or a parent of those. `--manifest` adds the map's bounds
 * and expected build/map; without it only the schema and shape rules run. Exit 1 when any error is found.
 * Collision checks need the loaded bundle, so the CLI runs in degraded mode (the report says so).
 */
const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const manifestPath = args.includes("--manifest") ? args[args.indexOf("--manifest") + 1] : undefined
const paths = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--manifest")
if (paths.length === 0) { console.error("usage: metadata:validate <file|dir>... [--manifest manifest.json] [--json]"); process.exit(2) }

let ctx: ValidationContext = {}
if (manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  ctx = { bounds: m.bounds, expect: { gameBuildId: m.gameBuildId, mapName: m.mapName } }
}

const reports = paths.flatMap((p) => checkPath(p, ctx))
if (flag("json")) console.log(JSON.stringify(reports, null, 2))
else {
  for (const { path, report } of reports) {
    console.log(`${report.ok ? "ok  " : "FAIL"} ${path}`)
    for (const i of report.issues) console.log(`  ${i.severity === "error" ? "✗" : "!"} [${i.code}] ${i.message}`)
  }
  console.log(reports.some((r) => !r.report.degraded) ? "" : "(collision checks skipped: no map bundle loaded)")
}
process.exit(reports.every((r) => r.report.ok) ? 0 : 1)
