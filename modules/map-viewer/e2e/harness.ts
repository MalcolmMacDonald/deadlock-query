import type { Entity, Manifest } from "@deadlock-query/contracts"
import { ViewerController, makeViewerPanel } from "../src/index.ts"

const get = (p: string) => fetch(`/fixture/${p}`)
const manifest = (await (await get("manifest.json")).json()) as Manifest
const entities = ((await (await get(manifest.entitiesFile)).json()) as { entities: Entity[] }).entities
const tiles = new Map<string, Uint8Array>()
for (const t of manifest.tiles) tiles.set(t.id, new Uint8Array(await (await get(t.file)).arrayBuffer()))
const controller = new ViewerController()
;(globalThis as any).__viewer = controller
;(globalThis as any).__events = [] as unknown[]
import { Effect, Stream } from "effect"
Effect.runFork(Stream.runForEach(controller.events, (e) => Effect.sync(() => (globalThis as any).__events.push(e))))
makeViewerPanel({ manifest, entities, tiles }, controller).mount(document.getElementById("app")!)
