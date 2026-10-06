import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { fetchData, parsePointer } from "./lib/data.ts"

/** `bun tools/fetch-data.ts [outDir]` — download the release named in data/current-build.json into outDir (default dist). */
if (import.meta.main) {
  const out = process.argv[2] ?? "dist"
  const pointer = parsePointer(JSON.parse(readFileSync("data/current-build.json", "utf8")))
  await fetchData(pointer, out)
  mkdirSync(`${out}/data`, { recursive: true })
  writeFileSync(`${out}/data/build.json`, JSON.stringify({ buildId: pointer.buildId, tag: pointer.tag }) + "\n")
  console.log(`fetched ${pointer.assets.length} asset(s) of ${pointer.tag} -> ${out}/data`)
}
