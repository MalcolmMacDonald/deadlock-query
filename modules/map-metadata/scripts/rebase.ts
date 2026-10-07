import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson, type Manifest, type MetadataKind } from "@deadlock-query/contracts"
import { readBuildDir } from "../src/dataDir.ts"
import { rebaseRecords } from "../src/rebase.ts"

/**
 * `bun run metadata:rebase -- --from <build-dir> --manifest <new manifest.json> [--out <dir>] [--dry-run] [--json]`
 * Re-validates accepted records against the new build's map (bounds; collision checks need the baked bundle and are skipped
 * here) and writes `data/metadata/<new build>/<kind>.json` with the ones that no longer fit marked `stale`. Exit 1 when any
 * record went stale, so a build bump cannot pass silently; a reviewer then re-confirms or moves them.
 */
const args = process.argv.slice(2)
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
const from = opt("from"), manifestPath = opt("manifest")
if (!from || !manifestPath) { console.error("usage: metadata:rebase --from <build-dir> --manifest <manifest.json> [--out <dir>] [--dry-run] [--json]"); process.exit(2) }
const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
const src = readBuildDir(from)
if (src.mapName !== m.mapName) { console.error(`map mismatch: ${from} is ${src.mapName}, the manifest is ${m.mapName}`); process.exit(2) }
const result = rebaseRecords(src.records, { bounds: m.bounds, expect: { gameBuildId: m.gameBuildId, mapName: m.mapName } })
const outDir = opt("out") ?? join(from, "..", m.gameBuildId)
if (!args.includes("--dry-run")) {
  mkdirSync(outDir, { recursive: true })
  const kinds = [...new Set(result.records.map((r) => r.kind))] as MetadataKind[]
  for (const kind of kinds) {
    const file = { schemaVersion: "1.0.0", gameBuildId: m.gameBuildId, mapName: m.mapName, records: result.records.filter((r) => r.kind === kind).sort((a, b) => (a.id < b.id ? -1 : 1)) }
    writeFileSync(join(outDir, `${kind}.json`), JSON.stringify(JSON.parse(canonicalJson(file)), null, 2) + "\n")
  }
}
if (args.includes("--json")) console.log(JSON.stringify({ kept: result.kept, stale: result.stale, degraded: result.degraded, out: outDir }, null, 2))
else {
  console.log(`${result.kept} kept, ${result.stale.length} stale${args.includes("--dry-run") ? " (dry run, nothing written)" : ` -> ${outDir}`}`)
  for (const s of result.stale) console.log(`  stale ${s.id}: ${s.reason}`)
  if (result.degraded) console.log("(collision checks skipped: only bounds and shape were tested)")
}
process.exit(result.stale.length > 0 ? 1 : 0)
