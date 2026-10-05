import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EntitiesFile, SCHEMA_VERSION } from "../src/index.ts"
import { buildMiniMap } from "../src/fixtures/miniMap.ts"

const root = join(import.meta.dir, "..", "fixtures", "mini-map")
const m = buildMiniMap()
const write = (rel: string, data: string | Uint8Array) => {
  const p = join(root, rel)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, data)
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n"
const entitiesFile: typeof EntitiesFile.Type = { schemaVersion: SCHEMA_VERSION, entities: m.entities }

write("manifest.json", json(m.manifest))
write("entities.json", json(entitiesFile))
write("render/t0.glb", m.renderGlb)
write("collision/physics.glb", m.collisionGlb)
write("expected/guardian-orb-distance.json", json(m.expectedGuardianOrbDistance))
console.log(`wrote fixtures to ${root}`)
