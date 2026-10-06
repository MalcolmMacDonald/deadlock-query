import { Effect } from "effect"
import * as THREE from "three"
import { MapDataService, type Entity, type Manifest } from "@deadlock-query/contracts"
import { boundsOf, fitTopDown } from "./projection.ts"
import { frameBounds, type CameraMode } from "./camera.ts"
import { FOV_DEG, ViewerControls } from "./controls.ts"
import { buildScene } from "./scene.ts"

export const VIEWER_PANEL_ID = "viewer.main"

export interface PanelComponent {
  /** Mounts the panel into `container`; returns a disposer. */
  readonly mount: (container: HTMLElement) => () => void
}

export interface ViewerData {
  readonly manifest: Manifest
  readonly entities: ReadonlyArray<Entity>
  /** Raw render-tile GLB bytes keyed by tile id. */
  readonly tiles: ReadonlyMap<string, Uint8Array>
}

export const loadViewerData = Effect.gen(function* () {
  const data = yield* MapDataService
  const manifest = yield* data.manifest
  const entities = yield* data.entities
  const tiles = new Map<string, Uint8Array>()
  for (const t of manifest.tiles) tiles.set(t.id, yield* data.loadTile(t.id))
  return { manifest, entities, tiles } satisfies ViewerData
})

const MODE_LABELS: ReadonlyArray<readonly [CameraMode, string]> = [["map", "Map"], ["orbit", "Orbit"], ["fly", "Fly"]]

export const makeViewerPanel = (data: ViewerData): PanelComponent => ({
  mount: (container) => {
    const root = document.createElement("div")
    root.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;background:#14161a"
    const canvas = document.createElement("canvas")
    canvas.dataset.testid = "viewer-canvas"
    canvas.style.cssText = "width:100%;height:100%;display:block;outline:none"
    root.appendChild(canvas)
    const bar = document.createElement("div")
    bar.style.cssText = "position:absolute;top:8px;left:8px;display:flex;gap:4px;font:12px sans-serif"
    root.appendChild(bar)
    container.appendChild(root)

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
    renderer.setClearColor(0x14161a)
    const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 5, 200_000)
    const scene = new THREE.Scene()
    let dirty = true
    let disposed = false
    let frame = 0
    const requestRender = () => {
      dirty = true
      if (!frame && !disposed) frame = requestAnimationFrame(draw)
    }
    const draw = () => {
      frame = 0
      if (!dirty || disposed) return
      dirty = false
      renderer.render(scene, camera)
      canvas.dataset.frames = String(Number(canvas.dataset.frames ?? "0") + 1)
    }

    const { min, max } = data.manifest.bounds
    const controls = new ViewerControls({
      element: canvas,
      camera,
      initial: { mode: "map", pose: frameBounds(min, max, FOV_DEG) },
      onChange: requestRender
    })
    const buttons = MODE_LABELS.map(([mode, label]) => {
      const b = document.createElement("button")
      b.textContent = label
      b.dataset.mode = mode
      b.onclick = () => { controls.setMode(mode); sync() }
      bar.appendChild(b)
      return b
    })
    const sync = () => {
      for (const b of buttons) b.style.fontWeight = b.dataset.mode === controls.mode ? "700" : "400"
      canvas.dataset.mode = controls.mode
    }
    sync()

    const resize = () => {
      const r = root.getBoundingClientRect()
      const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height))
      renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      requestRender()
    }
    resize()
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize)
    ro?.observe(root)

    buildScene(data).then((group) => {
      if (disposed) return
      scene.add(group)
      canvas.dataset.loaded = "true"
      requestRender()
    }, (err) => { canvas.dataset.error = String(err) })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      ro?.disconnect()
      controls.dispose()
      renderer.dispose()
      root.remove()
    }
  }
})
