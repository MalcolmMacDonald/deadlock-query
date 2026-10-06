import type { Entity, Manifest } from "@deadlock-query/contracts"
import { makeViewerPanel } from "../src/index.ts"

const get = (p: string) => fetch(`/fixture/${p}`)
const manifest = (await (await get("manifest.json")).json()) as Manifest
const entities = ((await (await get(manifest.entitiesFile)).json()) as { entities: Entity[] }).entities
const tiles = new Map<string, Uint8Array>()
for (const t of manifest.tiles) tiles.set(t.id, new Uint8Array(await (await get(t.file)).arrayBuffer()))
makeViewerPanel({ manifest, entities, tiles }).mount(document.getElementById("app")!)
