import type { Entity, Manifest } from "@deadlock-query/contracts"
import { ViewerController, makeLayersPanel, makeToolsPanel, makeViewerPanel } from "../src/index.ts"

const get = (p: string) => fetch(`/fixture/${p}`)
const manifest = (await (await get("manifest.json")).json()) as Manifest
const entities = ((await (await get(manifest.entitiesFile)).json()) as { entities: Entity[] }).entities
const tiles = new Map<string, Uint8Array>()
for (const t of manifest.tiles) tiles.set(t.id, new Uint8Array(await (await get(t.file)).arrayBuffer()))
const controller = new ViewerController()
;(globalThis as any).__viewer = controller
;(controller as any).__fixtureEntities = entities
;(globalThis as any).__events = [] as unknown[]
import { Effect, Stream } from "effect"
Effect.runFork(Stream.runForEach(controller.events, (e) => Effect.sync(() => (globalThis as any).__events.push(e))))
makeViewerPanel({ manifest, entities, tiles }, controller).mount(document.getElementById("app")!)
const side = (id: string, css: string) => {
  const d = document.createElement("div")
  d.id = id
  d.style.cssText = `position:fixed;top:48px;height:calc(100vh - 48px);width:200px;${css}`
  document.body.appendChild(d)
  return d
}
makeToolsPanel(controller).mount(side("tools", "left:0"))
makeLayersPanel(controller).mount(side("layers", "right:0"))
