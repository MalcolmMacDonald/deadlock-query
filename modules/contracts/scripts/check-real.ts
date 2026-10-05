/** Local only: bun run check:real -- <bundle-dir>. Validates an extractor bundle and reports fixture/real gaps. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { EntitiesFile, Manifest, decodeVersioned, type Entity } from "../src/index.ts"
import { buildMiniMap } from "../src/fixtures/miniMap.ts"

const dir = process.argv.slice(2).find((a) => a !== "--")
if (!dir) { console.error("usage: bun run check:real -- <bundle-dir>"); process.exit(2) }
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"))

const run = Effect.gen(function* () {
  const manifest = yield* decodeVersioned(Manifest, 1)(read("manifest.json"))
  const ents = yield* decodeVersioned(EntitiesFile, 1)(read(manifest.entitiesFile))
  const warnings: string[] = []
  const errors: string[] = []
  for (const t of manifest.tiles) if (!existsSync(join(dir, t.file))) errors.push(`missing tile file ${t.file}`)
  if (manifest.collision && !existsSync(join(dir, manifest.collision.file))) errors.push(`missing collision file`)
  const kinds = (es: ReadonlyArray<Entity>) => new Set(es.map((e) => e.kind).filter(Boolean))
  const fixtureKinds = kinds(buildMiniMap().entities)
  const realKinds = kinds(ents.entities)
  for (const k of fixtureKinds) if (!realKinds.has(k)) warnings.push(`fixture covers kind "${k}" but real data has none`)
  for (const k of realKinds) if (!fixtureKinds.has(k)) warnings.push(`real data has kind "${k}" the fixture lacks`)
  if (!manifest.collision) warnings.push("no collision reference in manifest (fixture has one)")
  const unmapped = ents.entities.filter((e) => !e.kind).length
  warnings.push(`${unmapped}/${ents.entities.length} entities have no normalised kind (preserved as raw class)`)
  return { errors, warnings }
})

const { errors, warnings } = await Effect.runPromise(run)
for (const w of warnings) console.warn(`! ${w}`)
for (const e of errors) console.error(`✗ ${e}`)
if (errors.length) process.exit(1)
console.log("check:real ok")
