import { Effect } from "effect"
import { MapDataService, type Entity, type Manifest } from "@deadlock-query/contracts"
import { boundsOf, fitTopDown } from "./projection.ts"

export const VIEWER_PANEL_ID = "viewer.main"

export interface PanelComponent {
  /** Mounts the panel into `container`; returns a disposer. */
  readonly mount: (container: HTMLElement) => () => void
}

export interface ViewerData {
  readonly manifest: Manifest
  readonly entities: ReadonlyArray<Entity>
}

export const loadViewerData = Effect.gen(function* () {
  const data = yield* MapDataService
  const manifest = yield* data.manifest
  const entities = yield* data.entities
  return { manifest, entities } satisfies ViewerData
})

const COLORS: Record<string, string> = { guardian: "#e8a33d", walker: "#d45d5d", patron: "#b04fd0", creepCamp: "#4fb36b" }

/** M0 placeholder: top-down 2D canvas of entities. Replaced by the Three.js renderer in M1. */
export const drawTopDown = (ctx: CanvasRenderingContext2D, w: number, h: number, entities: ReadonlyArray<Entity>) => {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = "#14161a"
  ctx.fillRect(0, 0, w, h)
  const project = fitTopDown(boundsOf(entities.map((e) => e.position), 300), w, h)
  for (const e of entities) {
    const [px, py] = project(e.position)
    ctx.fillStyle = COLORS[e.kind ?? ""] ?? "#8a8f98"
    ctx.beginPath()
    ctx.arc(px, py, 4, 0, Math.PI * 2)
    ctx.fill()
  }
}

export const makeViewerPanel = (data: ViewerData): PanelComponent => ({
  mount: (container) => {
    const canvas = document.createElement("canvas")
    canvas.dataset.testid = "viewer-canvas"
    canvas.style.cssText = "width:100%;height:100%;display:block"
    container.appendChild(canvas)
    const render = () => {
      const r = container.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(r.width))
      canvas.height = Math.max(1, Math.floor(r.height))
      const ctx = canvas.getContext("2d")
      if (ctx) drawTopDown(ctx, canvas.width, canvas.height, data.entities)
    }
    render()
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(render)
    ro?.observe(container)
    return () => {
      ro?.disconnect()
      canvas.remove()
    }
  }
})
