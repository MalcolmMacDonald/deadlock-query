import * as THREE from "three"
import type { OverlayFeature, OverlayStyle, Vec3 } from "@deadlock-query/contracts"
import { WORLD_TO_THREE } from "./scene.ts"
import { DRAFT_COLOR } from "./tools.ts"
import { DEFAULT_APPEARANCE, type LayerAppearance } from "./layers.ts"
import { layerLabels, makeLabelSprite } from "./labels.ts"

export const DEFAULT_COLOR = "#ffcc00"
export const DEFAULT_SIZE = 9
export const HIGHLIGHT_COLOR = "#ffffff"
const HANDLE_STYLE: OverlayStyle = { color: "#4fc3ff", size: 11 }
const ACTIVE_HANDLE_STYLE: OverlayStyle = { color: "#ffe14f", size: 15 }
export const FEATURE_SNAP_COLOR = "#ff4fd8"
export const VERTEX_SNAP_COLOR = "#4fff9a"

export interface OverlayLayerData {
  readonly features: ReadonlyArray<OverlayFeature>
  readonly style: OverlayStyle
}

let markerTexture: THREE.Texture | undefined
/**
 * Round point marker: a white disc inside a dark ring, tinted by the material colour so the disc takes the layer
 * colour and the ring keeps it legible over any surface. Needs a 2D canvas, so without a DOM points stay squares.
 */
const roundMarker = (): THREE.Texture | undefined => {
  if (markerTexture) return markerTexture
  if (typeof document === "undefined") return undefined
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined
  ctx.fillStyle = "#101216"
  ctx.beginPath(); ctx.arc(32, 32, 31, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = "#ffffff"
  ctx.beginPath(); ctx.arc(32, 32, 22, 0, Math.PI * 2); ctx.fill()
  markerTexture = new THREE.CanvasTexture(canvas)
  markerTexture.colorSpace = THREE.SRGBColorSpace
  return markerTexture
}

/** A bare `Vec3[]` is shorthand for a layer of points. */
export const normalizeFeatures = (
  input: ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>
): ReadonlyArray<OverlayFeature> =>
  input.map((f) => (Array.isArray(f) ? { type: "point", at: f as unknown as Vec3 } : f) as OverlayFeature)

export const featureId = (layerId: string, index: number): string => `${layerId}:${index}`

export const parseFeatureId = (id: string): { readonly layerId: string; readonly index: number } | undefined => {
  const i = id.lastIndexOf(":")
  const index = Number(id.slice(i + 1))
  return i < 0 || !Number.isInteger(index) ? undefined : { layerId: id.slice(0, i), index }
}

const ringOf = (f: OverlayFeature): ReadonlyArray<Vec3> =>
  f.type === "point" ? [f.at] : f.type === "polygon" ? f.ring : f.points

/** Camera-independent projection used for CPU picking: world position -> pixel (or undefined if behind the eye). */
export type Project = (p: Vec3) => readonly [x: number, y: number] | undefined

const segDist = (px: number, py: number, a: readonly [number, number], b: readonly [number, number]): number => {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / len2))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

const insidePolygon = (px: number, py: number, pts: ReadonlyArray<readonly [number, number]>): boolean => {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Nearest feature to a pixel within `radiusPx`, searching layers in the given order (later layers win ties). */
export const pickFeature = (
  layers: Iterable<readonly [string, OverlayLayerData]>,
  project: Project,
  px: number,
  py: number,
  radiusPx = 8
): string | null => {
  let best: string | null = null
  let bestD = Infinity
  for (const [layerId, layer] of layers) {
    const pointR = Math.max(radiusPx, (layer.style.size ?? DEFAULT_SIZE) / 2)
    layer.features.forEach((f, i) => {
      let d = Infinity
      let limit = radiusPx
      if (f.type === "point") {
        const s = project(f.at)
        if (s) d = Math.hypot(s[0] - px, s[1] - py)
        limit = pointR
      } else {
        const pts = ringOf(f).map(project)
        if (pts.some((p) => !p)) return
        const sp = pts as Array<readonly [number, number]>
        const n = f.type === "polygon" ? sp.length : sp.length - 1
        for (let k = 0; k < n; k++) d = Math.min(d, segDist(px, py, sp[k]!, sp[(k + 1) % sp.length]!))
        if (f.type === "polygon" && insidePolygon(px, py, sp)) d = Math.min(d, 0)
      }
      if (d <= limit && d <= bestD) { bestD = d; best = featureId(layerId, i) }
    })
  }
  return best
}

const flat = (pts: Iterable<Vec3>, n: number): Float32Array => {
  const out = new Float32Array(n * 3)
  let i = 0
  for (const p of pts) { out[i++] = p[0]; out[i++] = p[1]; out[i++] = p[2] }
  return out
}

const geometry = (positions: Float32Array, index?: number[]): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  if (index) g.setIndex(index)
  return g
}

/**
 * Three objects for a set of features, in world (Z-up) coordinates; the parent group applies `WORLD_TO_THREE`.
 * Points are one `Points` draw call (screen-space size), lines one `LineSegments`, polygons a fill mesh + outline.
 */
export const buildFeatureObjects = (
  features: ReadonlyArray<OverlayFeature>,
  style: OverlayStyle,
  opts: { readonly opacity?: number; readonly depthTest?: boolean; readonly labels?: boolean } = {}
): THREE.Object3D[] => {
  const color = new THREE.Color(style.color ?? DEFAULT_COLOR)
  const transparent = (opts.opacity ?? 1) < 1
  const common = { color, transparent, opacity: opts.opacity ?? 1, depthTest: opts.depthTest ?? false }
  const out: THREE.Object3D[] = []

  const points = features.filter((f): f is Extract<OverlayFeature, { type: "point" }> => f.type === "point")
  if (points.length) {
    const map = roundMarker()
    const mat = new THREE.PointsMaterial({ ...common, size: style.size ?? DEFAULT_SIZE, sizeAttenuation: false, ...(map ? { map, alphaTest: 0.5 } : {}) })
    out.push(new THREE.Points(geometry(flat(points.map((p) => p.at), points.length)), mat))
  }

  const segs: Vec3[] = []
  for (const f of features) {
    if (f.type === "segment" || f.type === "polyline") {
      const p = f.points
      for (let i = 0; i + 1 < p.length; i++) segs.push(p[i]!, p[i + 1]!)
    } else if (f.type === "polygon") {
      for (let i = 0; i < f.ring.length; i++) segs.push(f.ring[i]!, f.ring[(i + 1) % f.ring.length]!)
    }
  }
  if (segs.length) out.push(new THREE.LineSegments(geometry(flat(segs, segs.length)), new THREE.LineBasicMaterial(common)))

  const fillPos: Vec3[] = [], fillIdx: number[] = []
  for (const f of features) {
    if (f.type !== "polygon" || f.ring.length < 3) continue
    const base = fillPos.length
    const tris = THREE.ShapeUtils.triangulateShape(f.ring.map((p) => new THREE.Vector2(p[0], p[1])), [])
    fillPos.push(...f.ring)
    for (const t of tris) fillIdx.push(base + t[0]!, base + t[1]!, base + t[2]!)
  }
  if (fillIdx.length) {
    const mat = new THREE.MeshBasicMaterial({ ...common, transparent: true, opacity: (opts.opacity ?? 1) * 0.25, side: THREE.DoubleSide })
    out.push(new THREE.Mesh(geometry(flat(fillPos, fillPos.length), fillIdx), mat))
  }
  for (const o of out) o.renderOrder = 10
  // Text labels: billboards above the geometry (render order 12), sharing the layer's colour and opacity.
  for (const l of opts.labels === false ? [] : layerLabels(features)) {
    const sprite = makeLabelSprite(l.text, l.at, style.color ?? DEFAULT_COLOR)
    if (!sprite) continue
    sprite.material.opacity = opts.opacity ?? 1
    sprite.renderOrder = 12
    out.push(sprite)
  }
  return out
}

/** Scene-graph owner for all overlay layers plus the highlight layer. */
export class OverlayScene {
  readonly root = new THREE.Group()
  private readonly layers = new Map<string, OverlayLayerData & { readonly group: THREE.Group }>()
  private readonly appearances = new Map<string, LayerAppearance>()
  private readonly highlightGroup = new THREE.Group()
  private readonly draftGroup = new THREE.Group()
  private readonly handleGroup = new THREE.Group()
  private readonly snapGroup = new THREE.Group()
  private highlighted: ReadonlyArray<string> = []

  constructor(private readonly onChange: () => void = () => {}) {
    this.root.matrixAutoUpdate = false
    this.root.matrix.fromArray([...WORLD_TO_THREE])
    this.root.add(this.highlightGroup)
    this.root.add(this.draftGroup)
    this.root.add(this.handleGroup)
    this.root.add(this.snapGroup)
  }

  get layerIds(): ReadonlyArray<string> { return [...this.layers.keys()] }
  /** Visible layers in draw order (bottom to top); hidden layers cannot be picked. */
  layerData(): Iterable<readonly [string, OverlayLayerData]> {
    return [...this.layers.entries()].filter(([id]) => this.appearance(id).visible)
  }
  private appearance(id: string): LayerAppearance { return this.appearances.get(id) ?? DEFAULT_APPEARANCE }
  feature(id: string): OverlayFeature | undefined {
    const p = parseFeatureId(id)
    return p ? this.layers.get(p.layerId)?.features[p.index] : undefined
  }

  set(layerId: string, features: ReadonlyArray<Vec3> | ReadonlyArray<OverlayFeature>, style: OverlayStyle = {}) {
    this.dropGroup(layerId)
    const norm = normalizeFeatures(features)
    this.layers.set(layerId, { features: norm, style, group: this.buildGroup(layerId, norm, style) })
    this.rebuildHighlight()
    this.onChange()
  }

  /** Visibility, opacity, colour override and draw order for a layer; applies now or when the layer is set. */
  setAppearance(layerId: string, a: LayerAppearance) {
    this.appearances.set(layerId, a)
    const l = this.layers.get(layerId)
    if (!l) return
    this.dropGroup(layerId)
    this.layers.set(layerId, { ...l, group: this.buildGroup(layerId, l.features, l.style) })
    this.rebuildHighlight()
    this.onChange()
  }

  /** Transient preview geometry (tool rubber band); not a layer, never picked. */
  setDraft(features: ReadonlyArray<OverlayFeature>) {
    disposeTree(this.draftGroup)
    this.draftGroup.clear()
    for (const o of buildFeatureObjects(features, { color: DRAFT_COLOR, size: 8 })) { o.renderOrder = 15; this.draftGroup.add(o) }
    this.onChange()
  }

  /** Grab points for the selected annotation's vertices; `active` is drawn larger and in a different colour. */
  setHandles(points: ReadonlyArray<Vec3>, active?: number) {
    disposeTree(this.handleGroup)
    this.handleGroup.clear()
    const rest = points.filter((_, i) => i !== active)
    const add = (pts: ReadonlyArray<Vec3>, style: OverlayStyle) => {
      for (const o of buildFeatureObjects(pts.map((at) => ({ type: "point" as const, at })), style)) { o.renderOrder = 22; this.handleGroup.add(o) }
    }
    add(rest, HANDLE_STYLE)
    if (active !== undefined && points[active]) add([points[active]!], ACTIVE_HANDLE_STYLE)
    this.onChange()
  }

  /** Marker where a snap landed (feature / vertex snaps only); `undefined` clears it. */
  setSnapMarker(at: Vec3 | undefined, kind?: "feature" | "vertex") {
    disposeTree(this.snapGroup)
    this.snapGroup.clear()
    if (at) {
      for (const o of buildFeatureObjects([{ type: "point", at }], { color: kind === "feature" ? FEATURE_SNAP_COLOR : VERTEX_SNAP_COLOR, size: 13 })) { o.renderOrder = 25; this.snapGroup.add(o) }
    }
    this.onChange()
  }

  private buildGroup(layerId: string, features: ReadonlyArray<OverlayFeature>, style: OverlayStyle): THREE.Group {
    const a = this.appearance(layerId)
    const group = new THREE.Group()
    group.visible = a.visible
    // Layer order only ranks layers against each other; it stays below the draft (15) and highlight (20) passes.
    const rank = 10 + Math.min(Math.max(a.order, 0), 1000) * 0.004
    for (const o of buildFeatureObjects(features, a.color ? { ...style, color: a.color } : style, { opacity: a.opacity })) {
      o.renderOrder = o instanceof THREE.Sprite ? rank + 0.002 : rank
      group.add(o)
    }
    this.root.add(group)
    return group
  }

  remove(layerId: string) {
    this.dropGroup(layerId)
    this.layers.delete(layerId)
    this.appearances.delete(layerId)
    this.rebuildHighlight()
    this.onChange()
  }

  highlight(ids: ReadonlyArray<string>) {
    this.highlighted = ids
    this.rebuildHighlight()
    this.onChange()
  }

  dispose() {
    for (const id of [...this.layers.keys()]) this.dropGroup(id)
    this.clearHighlight()
    disposeTree(this.draftGroup)
    disposeTree(this.handleGroup)
    disposeTree(this.snapGroup)
  }

  private dropGroup(layerId: string) {
    const old = this.layers.get(layerId)
    if (!old) return
    this.root.remove(old.group)
    disposeTree(old.group)
  }

  private clearHighlight() {
    disposeTree(this.highlightGroup)
    this.highlightGroup.clear()
  }

  private rebuildHighlight() {
    this.clearHighlight()
    const feats: OverlayFeature[] = []
    let size = DEFAULT_SIZE
    for (const id of this.highlighted) {
      const f = this.feature(id)
      if (!f || !this.appearance(parseFeatureId(id)!.layerId).visible) continue
      feats.push(f)
      size = Math.max(size, (this.layers.get(parseFeatureId(id)!.layerId)!.style.size ?? DEFAULT_SIZE))
    }
    for (const o of buildFeatureObjects(feats, { color: HIGHLIGHT_COLOR, size: size * 1.8 }, { labels: false })) { o.renderOrder = 20; this.highlightGroup.add(o) }
  }
}

const disposeTree = (o: THREE.Object3D) =>
  o.traverse((c) => {
    const m = c as THREE.Mesh
    m.geometry?.dispose()
    ;(Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((x) => x.dispose())
  })
