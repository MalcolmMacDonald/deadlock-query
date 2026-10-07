import { Effect, Stream } from "effect"
import { ViewerService, type ExternalTool, type OverlayFeature, type OverlayStyle, type ToolContext, type Vec3 } from "@deadlock-query/contracts"
import { createEditorController, indexedDbDraftStorage, mountEditorPanel, openDraftStore } from "../src/editor/index.ts"

// A mock viewer: a top-down canvas where 1 pixel = 4 world units, centred on the origin. Enough to draw and reload.
const SCALE = 4
const canvas = document.getElementById("map") as HTMLCanvasElement
const g = canvas.getContext("2d")!
const tools = new Map<string, ExternalTool>()
const overlays = new Map<string, { features: ReadonlyArray<OverlayFeature>; style: OverlayStyle }>()
let draft: ReadonlyArray<OverlayFeature> = []
let active: ExternalTool | undefined
let hint = ""

const toScreen = (p: Vec3): [number, number] => [canvas.width / 2 + p[0] / SCALE, canvas.height / 2 - p[1] / SCALE]
const toWorld = (x: number, y: number): Vec3 => [(x - canvas.width / 2) * SCALE, -(y - canvas.height / 2) * SCALE, 0]

const drawFeature = (f: OverlayFeature, color: string, size: number) => {
  g.strokeStyle = g.fillStyle = color
  g.lineWidth = 2
  const path = (pts: ReadonlyArray<Vec3>, close: boolean) => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = toScreen(p); i ? g.lineTo(x, y) : g.moveTo(x, y) }); if (close) g.closePath() }
  if (f.type === "point") { const [x, y] = toScreen(f.at); g.beginPath(); g.arc(x, y, size / 2, 0, 7); g.fill() }
  else if (f.type === "polygon") { path(f.ring, true); g.globalAlpha = 0.25; g.fill(); g.globalAlpha = 1; g.stroke() }
  else { path(f.points, false); g.stroke() }
}
const redraw = () => {
  canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight
  g.clearRect(0, 0, canvas.width, canvas.height)
  for (const { features, style } of overlays.values()) for (const f of features) drawFeature(f, style.color ?? "#fff", style.size ?? 8)
  for (const f of draft) drawFeature(f, "#ffd34d", 8)
  ;(document.getElementById("hint") as HTMLElement).textContent = hint
}

const ctx: ToolContext = {
  commit: () => { throw new Error("harness: commit is not supported") },
  setDraft: (f) => { draft = f; redraw() },
  setStatus: (t) => { hint = t ?? ""; redraw() },
  done: () => activate(undefined)
}
const bar = document.getElementById("toolbar")!
const activate = (tool: ExternalTool | undefined) => {
  active?.deactivate?.(); active = tool; tool?.activate?.(ctx)
  for (const b of Array.from(bar.querySelectorAll("button"))) b.setAttribute("aria-pressed", String(b.dataset.tool === tool?.id))
  if (!tool) { draft = []; hint = "" }
  redraw()
}

const viewer: (typeof ViewerService)["Service"] = {
  loadBundle: () => Effect.void,
  getCamera: Effect.succeed({ position: [0, 0, 0], target: [0, 0, 0] }),
  setCamera: () => Effect.void,
  flyTo: () => Effect.void,
  events: Stream.empty,
  captureImage: Effect.succeed(new Uint8Array()),
  highlight: () => Effect.void,
  setOverlay: (id, features, style = {}) => Effect.sync(() => { overlays.set(id, { features: features as ReadonlyArray<OverlayFeature>, style }); redraw() }),
  removeOverlay: (id) => Effect.sync(() => { overlays.delete(id); redraw() }),
  registerTool: (tool) => Effect.sync(() => {
    tools.set(tool.id, tool)
    const b = document.createElement("button")
    b.textContent = tool.label; b.dataset.tool = tool.id; b.setAttribute("aria-pressed", "false")
    b.addEventListener("click", () => activate(tool))
    bar.append(b)
    return () => { tools.delete(tool.id); b.remove() }
  })
}

canvas.addEventListener("click", (e) => { const r = canvas.getBoundingClientRect(); active?.click?.(toWorld(e.clientX - r.left, e.clientY - r.top)) })
canvas.addEventListener("mousemove", (e) => { const r = canvas.getBoundingClientRect(); active?.move?.(toWorld(e.clientX - r.left, e.clientY - r.top)) })
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  if (e.key === "Enter") active?.finish?.(); else if (e.key === "Escape") active?.cancel?.()
})
window.addEventListener("resize", redraw)

const drafts = await openDraftStore(indexedDbDraftStorage("harness"))
const controller = createEditorController({ viewer, drafts })
mountEditorPanel(document.getElementById("panel")!, controller)
redraw()
Object.assign(self, { __md: { controller, drafts, activate, tools, toWorld, toScreen } })
