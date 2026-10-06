/** Local only: bun run check:real -- <bundle-dir>. Validates an extractor bundle and reports fixture/real gaps. */
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { EntitiesFile, Manifest, checkFiles, checkTiles, decodeVersioned, tileLod, type Entity } from "../src/index.ts"
import { buildMiniMap } from "../src/fixtures/miniMap.ts"

const argv = process.argv.slice(2)
const dir = argv.find((a) => a !== "--" && !a.startsWith("--"))
if (!dir) { console.error("usage: bun run check:real -- <bundle-dir> [--no-hash]"); process.exit(2) }
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"))

const run = Effect.gen(function* () {
  const manifest = yield* decodeVersioned(Manifest, 1)(read("manifest.json"))
  const ents = yield* decodeVersioned(EntitiesFile, 1)(read(manifest.entitiesFile))
  const warnings: string[] = []
  const errors: string[] = []
  const size = (f: string) => { try { return statSync(join(dir, f)).size } catch { return undefined } }
  const sha256 = (f: string) => createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")
  for (const r of [checkTiles(manifest), checkFiles(manifest, { size, sha256 }, { hash: !argv.includes("--no-hash") })]) {
    errors.push(...r.errors)
    warnings.push(...r.warnings)
  }
  const kinds = (es: ReadonlyArray<Entity>) => new Set(es.map((e) => e.kind).filter(Boolean))
  const fixtureKinds = kinds(buildMiniMap().entities)
  const realKinds = kinds(ents.entities)
  for (const k of fixtureKinds) if (!realKinds.has(k)) warnings.push(`fixture covers kind "${k}" but real data has none`)
  for (const k of realKinds) if (!fixtureKinds.has(k)) warnings.push(`real data has kind "${k}" the fixture lacks`)
  if (!manifest.collision) warnings.push("no collision reference in manifest (fixture has one)")
  const fixture = buildMiniMap().manifest
  if (manifest.baked && !fixture.baked) warnings.push("real bundle has manifest.baked (BVH, sample grid, navmesh?) the fixture lacks: its binaries need spatial-core, so the fixture stays unbaked")
  const lods = manifest.tiles.filter((t) => tileLod(t) > 0).length
  if (lods > 0 && !fixture.tiles.some((t) => tileLod(t) > 0)) warnings.push(`real bundle has ${lods} LOD tiles the fixture lacks`)
  if (lods > 0 && !manifest.tiles.some((t) => t.lod !== undefined)) warnings.push("LOD tiles are encoded only in the id (#lod<n>): extractor does not write `lod`/`lodOf` yet")
  console.log(`bundle: ${manifest.tiles.length} tiles (${manifest.tiles.length - lods} LOD0, ${lods} LOD>0), baked: ${manifest.baked ? "yes" : "no"}`)
  const unmapped = ents.entities.filter((e) => !e.kind).length
  warnings.push(`${unmapped}/${ents.entities.length} entities have no normalised kind (preserved as raw class)`)
  return { errors, warnings }
})

const { errors, warnings } = await Effect.runPromise(run)
for (const w of warnings) console.warn(`! ${w}`)
for (const e of errors) console.error(`✗ ${e}`)
if (errors.length) process.exit(1)
console.log("check:real ok")
