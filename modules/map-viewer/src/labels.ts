import * as THREE from "three"
import type { OverlayFeature, Vec3 } from "@deadlock-query/contracts"

/** Most labels one layer draws; beyond this the rest are skipped so a huge labelled query layer stays interactive. */
export const MAX_LABELS_PER_LAYER = 500
const FONT_PX = 13
const PAD_PX = 4
const MAX_TEXT = 120
const CACHE_LIMIT = 256

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

/** World point a feature's label hangs from: the point itself, the middle of a path by length, a polygon's vertex mean. */
export const labelAnchor = (f: OverlayFeature): Vec3 | undefined => {
  if (f.type === "point") return f.at
  if (f.type === "polygon") {
    if (f.ring.length === 0) return undefined
    const n = f.ring.length
    return [f.ring.reduce((s, p) => s + p[0], 0) / n, f.ring.reduce((s, p) => s + p[1], 0) / n, f.ring.reduce((s, p) => s + p[2], 0) / n]
  }
  const pts = f.points
  if (pts.length === 0) return undefined
  let total = 0
  for (let i = 0; i + 1 < pts.length; i++) total += len(sub(pts[i + 1]!, pts[i]!))
  if (total === 0) return pts[0]
  let rest = total / 2
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!
    const seg = len(sub(b, a))
    if (rest <= seg) {
      const t = seg === 0 ? 0 : rest / seg
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    }
    rest -= seg
  }
  return pts[pts.length - 1]
}

/** Labelled features of a layer with their anchors, capped at `MAX_LABELS_PER_LAYER`. */
export const layerLabels = (
  features: ReadonlyArray<OverlayFeature>
): ReadonlyArray<{ readonly text: string; readonly at: Vec3 }> => {
  const out: Array<{ text: string; at: Vec3 }> = []
  for (const f of features) {
    if (out.length >= MAX_LABELS_PER_LAYER) break
    const text = f.label?.trim()
    const at = text ? labelAnchor(f) : undefined
    if (text && at) out.push({ text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text, at })
  }
  return out
}

interface Rendered { readonly texture: THREE.Texture; readonly width: number; readonly height: number }
const cache = new Map<string, Rendered>()

/** Text rendering needs a 2D canvas; where there is no DOM (unit tests, workers) labels are skipped. */
export const canRenderLabels = (): boolean => typeof document !== "undefined"

const render = (text: string, color: string): Rendered | undefined => {
  const key = `${color}\n${text}`
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  if (!canRenderLabels()) return undefined
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1)
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")
  if (!ctx) return undefined
  const font = `${FONT_PX * ratio}px sans-serif`
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width + 2 * PAD_PX * ratio)
  const h = Math.ceil(FONT_PX * ratio * 1.4 + PAD_PX * ratio)
  canvas.width = w
  canvas.height = h
  ctx.font = font
  ctx.fillStyle = "rgba(16,18,22,0.78)"
  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, 4 * ratio)
  ctx.fill()
  ctx.fillStyle = color
  ctx.textBaseline = "middle"
  ctx.fillText(text, PAD_PX * ratio, h / 2 + ratio * 0.5)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const made = { texture, width: w / ratio, height: h / ratio }
  cache.set(key, made)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string
    cache.get(oldest)?.texture.dispose()
    cache.delete(oldest)
  }
  return made
}

const size = new THREE.Vector2()

/**
 * A billboard with `text` at `at` (world space), drawn at a constant pixel size whatever the camera distance. Pixel
 * size is applied per frame because it depends on the viewport and the camera's field of view.
 */
export const makeLabelSprite = (text: string, at: Vec3, color: string): THREE.Sprite | undefined => {
  const r = render(text, color)
  if (!r) return undefined
  const mat = new THREE.SpriteMaterial({ map: r.texture, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false })
  const sprite = new THREE.Sprite(mat)
  sprite.position.set(at[0], at[1], at[2])
  // Sit just above the anchor so the text does not cover its marker.
  sprite.center.set(0.5, -0.35)
  sprite.userData.label = text
  sprite.userData.px = { width: r.width, height: r.height }
  sprite.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getSize(size)
    const k = 2 / (size.y * (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5]!)
    if (Math.abs(sprite.scale.y - r.height * k) > 1e-9) {
      sprite.scale.set(r.width * k, r.height * k, 1)
      sprite.updateMatrixWorld(true)
    }
  }
  return sprite
}

/** A label's screen rectangle in pixels (top-left origin). */
export interface LabelRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * Which labels to draw so none overlap: greedy in the given order (earlier wins), skipping any that would cover one
 * already kept. Zooming in spreads the anchors apart, so more labels fit.
 */
export const declutter = (rects: ReadonlyArray<LabelRect | undefined>, gap = 2): boolean[] => {
  const kept: LabelRect[] = []
  return rects.map((r) => {
    if (!r) return false
    const hit = kept.some((k) => r.x < k.x + k.width + gap && k.x < r.x + r.width + gap && r.y < k.y + k.height + gap && k.y < r.y + r.height + gap)
    if (!hit) kept.push(r)
    return !hit
  })
}

const ndc = new THREE.Vector3()

/** Hides label sprites under `root` that would overlap an earlier one or sit behind the camera (call before each render). */
export const declutterLabels = (root: THREE.Object3D, camera: THREE.Camera, width: number, height: number): void => {
  const sprites: THREE.Sprite[] = []
  root.traverse((o) => { if ((o as THREE.Sprite).isSprite && o.userData.px) sprites.push(o as THREE.Sprite) })
  if (sprites.length === 0) return
  // The layer drawn on top wins a clash (annotations and query results over entity names); ties keep scene order.
  sprites.sort((a, b) => ((b.userData.priority as number | undefined) ?? 0) - ((a.userData.priority as number | undefined) ?? 0))
  root.updateWorldMatrix(true, true)
  const rects = sprites.map((s): LabelRect | undefined => {
    if (!s.parent?.visible) return undefined
    ndc.setFromMatrixPosition(s.matrixWorld).project(camera)
    if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 1.2 || Math.abs(ndc.y) > 1.2) return undefined
    const { width: w, height: h } = s.userData.px as { width: number; height: number }
    const x = (ndc.x * 0.5 + 0.5) * width, y = (-ndc.y * 0.5 + 0.5) * height
    // The sprite hangs above its anchor (`center` y = -0.35), so its rectangle spans 0.35h..1.35h above it.
    return { x: x - w / 2, y: y - 1.35 * h, width: w, height: h }
  })
  const show = declutter(rects)
  sprites.forEach((s, i) => { s.visible = show[i]! })
}
