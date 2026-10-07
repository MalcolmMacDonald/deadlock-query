import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson, makeMetadataBundle } from "@deadlock-query/contracts"
import { checkBuildDir, readBuildDir } from "../src/dataDir.ts"

/**
 * `bun run metadata:merge -- <build-dir> [--check]`: writes `<build-dir>/metadata.bundle.json` from the per-kind files
 * (records ordered by kind then id, content hash filled in, same input = same bytes). `--check` writes nothing and exits 1
 * when the bundle is missing or out of date: CI uses it so a data PR cannot forget to rebuild. Invalid data exits 1 first.
 */
const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith("--"))
if (!dir) { console.error("usage: metadata:merge <build-dir> [--check]"); process.exit(2) }
const bad = checkBuildDir(dir).filter((r) => !r.report.ok && !r.path.endsWith("metadata.bundle.json"))
if (bad.length) { for (const b of bad) console.error(`FAIL ${b.path}: ${b.report.issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ")}`); process.exit(1) }
const d = readBuildDir(dir)
const text = JSON.stringify(JSON.parse(canonicalJson(makeMetadataBundle(d, d.records))), null, 2) + "\n"
const out = join(dir, "metadata.bundle.json")
if (args.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) { console.error(`${out} is missing or stale: run bun run metadata:merge -- ${dir}`); process.exit(1) }
  console.log(`ok   ${out}`)
} else { writeFileSync(out, text); console.log(`wrote ${out} (${d.records.length} records)`) }
