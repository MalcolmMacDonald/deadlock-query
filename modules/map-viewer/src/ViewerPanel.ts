import { Effect } from "effect"
import * as THREE from "three"
import { MapDataService, type Entity, type Manifest, type Vec3 } from "@deadlock-query/contracts"
import { boundsOf, fitTopDown } from "./projection.ts"
import { frameBounds, type CameraMode } from "./camera.ts"
import { FOV_DEG, ViewerControls } from "./controls.ts"
import { buildScene, surfaceMeshes } from "./scene.ts"
import { OverlayScene, pickFeature } from "./overlays.ts"
import { ViewerController } from "./viewerService.ts"
import { eyeOf } from "./camera.ts"

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
  /** Raw collision GLB bytes (drawn when the bundle has no render tiles). */
  readonly collision?: Uint8Array | undefined
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

export const makeViewerPanel = (data: ViewerData, controller: ViewerController = new ViewerController()): PanelComponent => ({
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

    const overlays = new OverlayScene(requestRender)
    scene.add(overlays.root)

    const { min, max } = data.manifest.bounds
    let live: ViewerControls | undefined
    const controls = new ViewerControls({
      element: canvas,
      camera,
      initial: { mode: "map", pose: frameBounds(min, max, FOV_DEG) },
      onChange: () => {
        requestRender()
        if (live) controller.emit({ _tag: "camera", position: eyeOf(live.pose), target: live.pose.target })
      }
    })
    live = controls
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

    let world: THREE.Group | undefined
    const setWorld = (g: THREE.Group) => {
      if (world) scene.remove(world)
      world = g
      scene.add(g)
      canvas.dataset.loaded = "true"
      requestRender()
    }
    buildScene(data).then((g) => { if (!disposed) setWorld(g) }, (err) => { canvas.dataset.error = String(err) })

    const project = (p: Vec3): readonly [number, number] | undefined => {
      const v = new THREE.Vector3(p[0], p[2], -p[1]).project(camera)
      if (v.z < -1 || v.z > 1) return undefined
      const r = canvas.getBoundingClientRect()
      return [(v.x * 0.5 + 0.5) * r.width, (-v.y * 0.5 + 0.5) * r.height]
    }
    const pickAt = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      return pickFeature(overlays.layerData(), project, e.clientX - r.left, e.clientY - r.top)
    }
    // Annotation tools place points on the first terrain hit, falling back to the horizontal plane through the
    // last placed point (or the camera target). Hover previews use the plane only: a mesh raycast per mouse move
    // is too slow on the real map until BVH picking lands.
    const raycaster = new THREE.Raycaster()
    const ndc = (e: PointerEvent): THREE.Vector2 => {
      const r = canvas.getBoundingClientRect()
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
    let lastZ: number | undefined
    const worldAt = (e: PointerEvent, useMesh: boolean): Vec3 | undefined => {
      raycaster.setFromCamera(ndc(e), camera)
      if (useMesh && world) {
        world.updateMatrixWorld(true)
        const hit = raycaster.intersectObjects(surfaceMeshes(world), false)[0]
        if (hit) return [hit.point.x, -hit.point.z, hit.point.y]
      }
      const z = lastZ ?? controls.pose.target[2]
      const at = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -z), new THREE.Vector3())
      return at ? [at.x, -at.z, at.y] : undefined
    }
    const toolActive = () => controller.tools.tool !== "select"
    let hovered: string | null = null
    let down: { x: number; y: number } | undefined
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return
      if (toolActive()) {
        const p = worldAt(e, false)
        if (p) controller.tools.move(p)
        return
      }
      const id = pickAt(e)
      if (id !== hovered) { hovered = id; controller.emit({ _tag: "hover", id }) }
    }
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      if (toolActive()) {
        if (e.button !== 0) return
        const p = worldAt(e, true)
        if (p) { lastZ = p[2]; controller.tools.click(p) }
        return
      }
      const id = pickAt(e)
      if (id) {
        controller.emit({ _tag: "pick", id })
        controller.selectFeature(id)
      } else controller.selectAnnotation(undefined)
    }
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.key === "Escape") controller.tools.cancel()
      else if (e.key === "Enter") controller.tools.finish()
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? controller.annotations.redo() : controller.annotations.undo() }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); controller.annotations.redo() }
      else if (e.key === "Delete" || e.key === "Backspace") controller.deleteSelected()
    }
    const onDblClick = () => controller.tools.finish()
    canvas.addEventListener("pointermove", onMove)
    canvas.addEventListener("pointerdown", onDown)
    canvas.addEventListener("pointerup", onUp)
    canvas.addEventListener("keydown", onKey)
    canvas.addEventListener("dblclick", onDblClick)
    const syncTool = () => { canvas.dataset.tool = controller.tools.tool; canvas.style.cursor = toolActive() ? "crosshair" : "" }
    const unsubTool = controller.tools.subscribe(syncTool)
    syncTool()

    controller.setMap({ mapName: data.manifest.mapName, gameBuildId: data.manifest.gameBuildId })
    controller.useDefaultStorage()
    const detach = controller.attach({
      setOverlay: (id, f, s) => overlays.set(id, f, s),
      removeOverlay: (id) => overlays.remove(id),
      highlight: (ids) => overlays.highlight(ids),
      setAppearance: (id, a) => overlays.setAppearance(id, a),
      setDraft: (f) => overlays.setDraft(f),
      getPose: () => controls.pose,
      setPose: (p) => controls.setPose(p),
      capture: async () => {
        renderer.render(scene, camera)
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"))
        if (!blob) throw new Error("canvas capture failed")
        return new Uint8Array(await blob.arrayBuffer())
      },
      loadBundle: async (manifestUrl) => {
        const base = new URL(manifestUrl, globalThis.location?.href)
        const get = async (p: string) => {
          const res = await fetch(new URL(p, base))
          if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`)
          return res
        }
        const manifest = (await (await get(base.href)).json()) as Manifest
        const entities = ((await (await get(manifest.entitiesFile)).json()) as { entities: Entity[] }).entities
        const tiles = new Map<string, Uint8Array>()
        for (const t of manifest.tiles) tiles.set(t.id, new Uint8Array(await (await get(t.file)).arrayBuffer()))
        const collision = manifest.collision ? new Uint8Array(await (await get(manifest.collision.file)).arrayBuffer()) : undefined
        const g = await buildScene({ manifest, entities, tiles, collision })
        if (!disposed) {
          controller.setMap({ mapName: manifest.mapName, gameBuildId: manifest.gameBuildId })
          setWorld(g)
          controls.setPose(frameBounds(manifest.bounds.min, manifest.bounds.max, FOV_DEG))
        }
      }
    })

    return () => {
      disposed = true
      detach()
      canvas.removeEventListener("pointermove", onMove)
      canvas.removeEventListener("pointerdown", onDown)
      canvas.removeEventListener("pointerup", onUp)
      canvas.removeEventListener("keydown", onKey)
      canvas.removeEventListener("dblclick", onDblClick)
      unsubTool()
      overlays.dispose()
      cancelAnimationFrame(frame)
      ro?.disconnect()
      controls.dispose()
      renderer.dispose()
      root.remove()
    }
  }
})
