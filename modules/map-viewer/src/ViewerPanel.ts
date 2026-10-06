import { Effect } from "effect"
import * as THREE from "three"
import { MapDataService, type Entity, type Manifest, type Vec3 } from "@deadlock-query/contracts"
import { boundsOf, fitTopDown } from "./projection.ts"
import { frameBounds, type CameraMode } from "./camera.ts"
import { FOV_DEG, ViewerControls } from "./controls.ts"
import { buildScene, glbToThreeMatrix, makeTerrainMaterial, surfaceMeshes } from "./scene.ts"
import { OverlayScene, parseFeatureId, pickFeature } from "./overlays.ts"
import { MAX_CAPTURE_SCALE, ViewerController } from "./viewerService.ts"
import { eyeOf } from "./camera.ts"
import { SurfacePicker, threeToWorld, worldTriangleSoup } from "./picking.ts"
import { snap, snapCandidates, type SnapResult } from "./snapping.ts"
import { annotationIdForFeature } from "./annotations.ts"
import { nearestEdge, nearestVertex } from "./vertexEdit.ts"
import { buildTileIndex, type ManifestTile } from "./tiles.ts"
import { TileStreamer, type StreamStats } from "./tileStreamer.ts"
import { defaultDecoder } from "./defaultDecoder.ts"
import type { TileDecoder } from "./tileDecode.ts"

export const VIEWER_PANEL_ID = "viewer.main"

export interface PanelComponent {
  /** Mounts the panel into `container`; returns a disposer. */
  readonly mount: (container: HTMLElement) => () => void
}

/** Tile streaming settings (`ViewerData.tileSource` turns streaming on). */
export interface StreamingConfig {
  /** Decoded geometry kept resident, in bytes (default 512 MB). */
  readonly budgetBytes?: number
  /** Tiles fetching/decoding at once (default 4). */
  readonly maxInFlight?: number
  /** Decode workers (default 2; 0 decodes on the main thread). Ignored when `decoder` is given. */
  readonly workers?: number
  /** Replaces the worker pool (tests, hosts with their own worker setup). */
  readonly decoder?: TileDecoder
  /** Distance, in tile diagonals, within which a tile shows its finest LOD (default 1.5). */
  readonly lod0Range?: number
}

export interface ViewerData {
  readonly manifest: Manifest
  readonly entities: ReadonlyArray<Entity>
  /** Raw render-tile GLB bytes keyed by tile id (drawn eagerly; leave empty when streaming through `tileSource`). */
  readonly tiles: ReadonlyMap<string, Uint8Array>
  /** Fetches one tile's GLB. When set, tiles are streamed by camera (frustum + LOD + memory budget) instead of read from `tiles`. */
  readonly tileSource?: ((tile: ManifestTile) => Promise<Uint8Array>) | undefined
  readonly streaming?: StreamingConfig | undefined
  /** Raw collision GLB bytes (drawn when the bundle has no render tiles). */
  readonly collision?: Uint8Array | undefined
  /** Bytes of the bundle's `baked/collision.bvh` (spatial-core `Raycaster.serialize()`); picking builds its own BVH without it. */
  readonly bakedBvh?: Uint8Array | undefined
}

/** Path of the baked collision BVH in a manifest (`baked.bvh.file`), if the bundle was baked. */
export const bakedBvhFile = (manifest: Manifest): string | undefined => {
  const bvh = (manifest.baked as { readonly bvh?: { readonly file?: unknown } } | undefined)?.bvh
  return typeof bvh?.file === "string" ? bvh.file : undefined
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

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true })
    renderer.setClearColor(0x14161a, 1)
    const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 5, 200_000)
    const scene = new THREE.Scene()
    let dirty = true
    let streamDirty = false
    let streamer: TileStreamer | undefined
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
      if (streamDirty && streamer) { streamDirty = false; streamer.update(camera) }
      renderer.render(scene, camera)
      canvas.dataset.frames = String(Number(canvas.dataset.frames ?? "0") + 1)
    }

    const overlays = new OverlayScene(requestRender)
    scene.add(overlays.root)

    const { min, max } = data.manifest.bounds
    let live: ViewerControls | undefined
    let grabsHandle: (e: PointerEvent) => boolean = () => false
    const controls = new ViewerControls({
      element: canvas,
      camera,
      initial: { mode: "map", pose: frameBounds(min, max, FOV_DEG) },
      intercept: (e) => grabsHandle(e),
      onChange: () => {
        streamDirty = true
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
      streamDirty = true
      requestRender()
    }
    resize()
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize)
    ro?.observe(root)

    let world: THREE.Group | undefined
    // Surface picking runs on a BVH: the bundle's baked collision BVH when there is one, else one built (lazily,
    // on first use) from the visible meshes in the scene.
    let bakedBvh = data.bakedBvh
    let picker: SurfacePicker | undefined
    let pickerReady = false
    const getPicker = (): SurfacePicker | undefined => {
      if (pickerReady) return picker
      pickerReady = true
      if (bakedBvh) {
        try { picker = SurfacePicker.fromBaked(bakedBvh) } catch (err) { console.warn("baked collision BVH unusable, building from meshes:", err) }
      }
      if (!picker && world) {
        world.updateMatrixWorld(true)
        const meshes = surfaceMeshes(world)
        if (streamer) { streamer.root.updateMatrixWorld(true); meshes.push(...surfaceMeshes(streamer.root)) }
        picker = SurfacePicker.fromSoup(worldTriangleSoup(meshes))
      }
      canvas.dataset.picker = picker?.source ?? "none"
      return picker
    }
    const setWorld = (g: THREE.Group) => {
      if (world) scene.remove(world)
      world = g
      picker = undefined
      pickerReady = false
      scene.add(g)
      canvas.dataset.loaded = "true"
      requestRender()
    }
    buildScene(data).then((g) => { if (!disposed) setWorld(g) }, (err) => { canvas.dataset.error = String(err) })

    // Tile streaming (when the data has a `tileSource`): tiles come and go with the camera, within a memory budget.
    let lastStats = ""
    const startStreaming = (d: ViewerData) => {
      streamer?.dispose()
      if (streamer) scene.remove(streamer.root)
      streamer = undefined
      if (!d.tileSource || d.manifest.tiles.length === 0) return
      const cfg = d.streaming ?? {}
      const fetchTile = d.tileSource
      const s = new TileStreamer({
        cells: buildTileIndex(d.manifest.tiles),
        fetchTile,
        decoder: cfg.decoder ?? defaultDecoder(cfg.workers),
        glbToThree: glbToThreeMatrix(d.manifest.coordinateSystem.glbToWorld),
        material: makeTerrainMaterial(),
        ...(cfg.budgetBytes === undefined ? {} : { budgetBytes: cfg.budgetBytes }),
        ...(cfg.maxInFlight === undefined ? {} : { maxInFlight: cfg.maxInFlight }),
        ...(cfg.lod0Range === undefined ? {} : { select: { lod0Range: cfg.lod0Range } }),
        onChange: () => {
          // A BVH built from the meshes goes stale when tiles come and go; the baked one does not.
          if (picker?.source === "meshes") { picker = undefined; pickerReady = false }
          requestRender()
        },
        onStats: (st) => {
          const sig = `${st.loading}/${st.resident}/${st.residentBytes}/${st.evicted}/${st.missing}/${st.displayed}/${st.failed}`
          if (sig === lastStats) return
          lastStats = sig
          canvas.dataset.tileResident = String(st.resident)
          canvas.dataset.tileBytes = String(st.residentBytes)
          canvas.dataset.tilePeak = String(st.peakBytes)
          canvas.dataset.tileBudget = String(st.budgetBytes)
          canvas.dataset.tileLoading = String(st.loading)
          canvas.dataset.tileMissing = String(st.missing)
          canvas.dataset.tileDisplayed = String(st.displayed)
          canvas.dataset.tileEvicted = String(st.evicted)
          controller.emitProgress(st)
        }
      })
      streamer = s
      scene.add(s.root)
      streamDirty = true
      requestRender()
    }
    startStreaming(data)

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
    // Annotation tools place points through `locate`: snap to an existing vertex, then to a corner of the triangle
    // under the cursor, then to the collision surface, then to the horizontal plane through the last placed point
    // (or the camera target) when nothing is hit.
    const raycaster = new THREE.Raycaster()
    const cursorOf = (e: PointerEvent): readonly [number, number] => {
      const r = canvas.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const ndc = (e: PointerEvent): THREE.Vector2 => {
      const r = canvas.getBoundingClientRect()
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
    let lastZ: number | undefined
    const locate = (e: PointerEvent, editing = false): SnapResult | undefined => {
      raycaster.setFromCamera(ndc(e), camera)
      const o = raycaster.ray.origin, d = raycaster.ray.direction
      const hit = getPicker()?.raycast(threeToWorld(o.x, o.y, o.z), threeToWorld(d.x, d.y, d.z))
      const z = lastZ ?? controls.pose.target[2]
      const at = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -z), new THREE.Vector3())
      const edited = editing ? controller.selectedAnnotation : undefined
      return snap({
        hit,
        plane: at ? threeToWorld(at.x, at.y, at.z) : undefined,
        cursor: cursorOf(e),
        project,
        candidates: snapCandidates(
          overlays.layerData(),
          editing ? [] : controller.tools.placed,
          edited ? (fid) => annotationIdForFeature(controller.annotations.annotations, fid, controller.annotations.layers) === edited : undefined
        ),
        settings: controller.snapping.settings
      })
    }
    const showSnap = (r: SnapResult | undefined) =>
      overlays.setSnapMarker(r && r.kind !== "surface" && r.kind !== "plane" ? r.point : undefined, r && (r.kind === "feature" || r.kind === "vertex") ? r.kind : undefined)
    const toolActive = () => controller.tools.tool !== "select"
    const handleAt = (e: PointerEvent): number | undefined => {
      const [x, y] = cursorOf(e)
      return nearestVertex(controller.vertexHandles(), project, x, y)
    }
    grabsHandle = (e) => e.button === 0 && !toolActive() && handleAt(e) !== undefined
    let hovered: string | null = null
    let down: { x: number; y: number } | undefined
    /** A handle drag in progress; `moved` once the pointer left the click tolerance. */
    let vertexDrag: { readonly index: number; moved: boolean } | undefined
    const onMove = (e: PointerEvent) => {
      if (vertexDrag) {
        if (!vertexDrag.moved && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) vertexDrag.moved = true
        if (vertexDrag.moved) {
          const r = locate(e, true)
          showSnap(r)
          if (r) controller.moveVertex(vertexDrag.index, r.point)
        }
        return
      }
      if (e.buttons) return
      if (toolActive()) {
        const r = locate(e)
        showSnap(r)
        if (r) controller.tools.move(r.point)
        return
      }
      showSnap(undefined)
      const id = pickAt(e)
      if (id !== hovered) { hovered = id; controller.emit({ _tag: "hover", id }) }
    }
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY }
      const i = grabsHandle(e) ? handleAt(e) : undefined
      if (i === undefined) return
      vertexDrag = { index: i, moved: false }
      canvas.setPointerCapture?.(e.pointerId)
      controller.selectVertex(i)
    }
    const onUp = (e: PointerEvent) => {
      if (vertexDrag) {
        const moved = vertexDrag.moved
        vertexDrag = undefined
        showSnap(undefined)
        if (moved) controller.commitVertexEdit()
        down = undefined
        return
      }
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      if (toolActive()) {
        if (e.button !== 0) return
        const r = locate(e)
        if (r) { lastZ = r.point[2]; controller.tools.click(r.point) }
        return
      }
      const id = pickAt(e)
      if (id) {
        controller.emit({ _tag: "pick", id })
        controller.selectFeature(id, e.shiftKey || e.ctrlKey || e.metaKey)
      } else if (!(e.shiftKey || e.ctrlKey || e.metaKey)) controller.selectAnnotation(undefined)
    }
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.key === "Escape") {
        if (vertexDrag) { vertexDrag = undefined; controller.cancelVertexEdit(); showSnap(undefined) }
        else controller.tools.cancel()
      }
      else if (e.key === "Enter") controller.tools.finish()
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? controller.annotations.redo() : controller.annotations.undo() }
      else if (mod && e.key.toLowerCase() === "a" && !toolActive()) { e.preventDefault(); controller.selectAll() }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); controller.annotations.redo() }
      else if (e.key === "Delete" || e.key === "Backspace") controller.deleteVertexOrSelected()
    }
    // Select tool: double-click on an edge of the selected polyline/polygon inserts a vertex there.
    const onDblClick = (e: MouseEvent) => {
      if (toolActive()) { controller.tools.finish(); return }
      const a = controller.selection.length === 1 ? controller.annotations.annotations.find((x) => x.id === controller.selectedAnnotation) : undefined
      if (!a) return
      const [x, y] = cursorOf(e as PointerEvent)
      const edge = nearestEdge(a, project, x, y)
      if (edge && nearestVertex(a.points, project, x, y) === undefined) controller.insertVertexAfter(edge.after, edge.point)
    }
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
      setHandles: (pts, active) => overlays.setHandles(pts, active),
      getPose: () => controls.pose,
      setPose: (p) => controls.setPose(p),
      capture: async (opts) => {
        const scale = Math.min(MAX_CAPTURE_SCALE, Math.max(1, Math.round(opts?.scale ?? 1)))
        const transparent = opts?.transparent === true
        const ratio = renderer.getPixelRatio()
        const w = Math.max(1, Math.floor(root.getBoundingClientRect().width)), h = Math.max(1, Math.floor(root.getBoundingClientRect().height))
        const restyle = scale > 1 || transparent
        if (scale > 1) { renderer.setPixelRatio(ratio * scale); renderer.setSize(w, h, false) }
        if (transparent) renderer.setClearAlpha(0)
        try {
          renderer.render(scene, camera)
          const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"))
          if (!blob) throw new Error("canvas capture failed")
          return new Uint8Array(await blob.arrayBuffer())
        } finally {
          if (restyle) {
            if (transparent) renderer.setClearAlpha(1)
            if (scale > 1) { renderer.setPixelRatio(ratio); renderer.setSize(w, h, false) }
            requestRender()
          }
        }
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
        // Tiles are streamed by camera; only the collision GLB and the BVH are fetched up front.
        const tileSource = async (t: ManifestTile) => new Uint8Array(await (await get(t.file)).arrayBuffer())
        const collision = manifest.collision ? new Uint8Array(await (await get(manifest.collision.file)).arrayBuffer()) : undefined
        const loaded: ViewerData = { manifest, entities, tiles: new Map(), tileSource, streaming: data.streaming, collision }
        const g = await buildScene(loaded)
        const baked = bakedBvhFile(manifest)
        const bvh = baked ? await get(baked).then(async (r) => new Uint8Array(await r.arrayBuffer())).catch((err) => { console.warn("baked collision BVH not loaded:", err); return undefined }) : undefined
        if (!disposed) {
          bakedBvh = bvh
          controller.setMap({ mapName: manifest.mapName, gameBuildId: manifest.gameBuildId })
          setWorld(g)
          startStreaming(loaded)
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
      streamer?.dispose()
      cancelAnimationFrame(frame)
      ro?.disconnect()
      controls.dispose()
      renderer.dispose()
      root.remove()
    }
  }
})
