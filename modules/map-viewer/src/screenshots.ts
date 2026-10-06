import { Effect } from "effect"
import {
  decodeVersioned, poseError, ScreenshotSet, validateScreenshotSet,
  type OverlayFeature, type OverlayStyle, type Shot, type ShotPose, type Vec3
} from "@deadlock-query/contracts"

/** Screenshot overlay layer ids: `screenshots` are the pickable markers, `screenshots.view` the frustum glyphs. */
export const SHOT_LAYER = "screenshots"
export const SHOT_VIEW_LAYER = "screenshots.view"
export const isShotLayerId = (id: string): boolean => id === SHOT_LAYER || id === SHOT_VIEW_LAYER

const SHOT_COLOR = "#ffcf4a"
const PLACEHOLDER_COLOR = "#8a8f98"
/** World units from the camera to the far rectangle of a frustum glyph. */
export const GLYPH_LENGTH = 150

const rad = (deg: number) => (deg * Math.PI) / 180
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** The pose a shot actually has: the game's read-back pose when there is one, else the requested one. */
export const shotPose = (shot: Pick<Shot, "requested" | "actual">): ShotPose => shot.actual ?? shot.requested

/**
 * Camera axes in world space (Z-up) for Source angles `(pitch, yaw, roll)` in degrees: pitch is positive looking
 * down, yaw counter-clockwise from +X, roll about the view axis (positive tilts the right side down).
 */
export const viewAxes = (angles: Vec3): { readonly forward: Vec3; readonly right: Vec3; readonly up: Vec3 } => {
  const p = rad(angles[0]), y = rad(angles[1]), r = rad(angles[2])
  const forward: Vec3 = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)]
  const right0: Vec3 = [Math.sin(y), -Math.cos(y), 0]
  const up0 = cross(right0, forward)
  const right = add(scale(right0, Math.cos(r)), scale(up0, -Math.sin(r)))
  const up = add(scale(up0, Math.cos(r)), scale(right0, Math.sin(r)))
  return { forward, right, up }
}

/** The two polylines of a frustum glyph: the far rectangle, and the four edges back to the camera. */
export const frustumGlyph = (shot: Shot, fovDeg: number, length = GLYPH_LENGTH): ReadonlyArray<OverlayFeature> => {
  const pose = shotPose(shot)
  const { forward, right, up } = viewAxes(pose.angles)
  const halfH = Math.tan(rad(fovDeg) / 2) * length
  const halfW = halfH * (shot.width / shot.height)
  const centre = add(pose.position, scale(forward, length))
  const corner = (sx: number, sy: number): Vec3 => add(centre, add(scale(right, sx * halfW), scale(up, sy * halfH)))
  const [a, b, c, d] = [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)] as const
  const apex = pose.position
  return [
    { type: "polyline", points: [a, b, c, d, a] },
    { type: "polyline", points: [apex, a, apex, b, apex, c, apex, d] }
  ]
}

export interface ScreenshotLayers {
  readonly markers: { readonly id: string; readonly label: string; readonly style: OverlayStyle; readonly features: ReadonlyArray<OverlayFeature> }
  readonly view: { readonly id: string; readonly label: string; readonly style: OverlayStyle; readonly features: ReadonlyArray<OverlayFeature> }
}

/**
 * Overlay layers for a set: one point per shot at its position (feature index = shot index) and the frustum glyphs
 * (two features per shot, so shot index = feature index >> 1). A placeholder set (dry run) is drawn grey.
 */
export const screenshotLayers = (set: Pick<ScreenshotSet, "shots" | "fov" | "placeholder">): ScreenshotLayers => {
  const color = set.placeholder ? PLACEHOLDER_COLOR : SHOT_COLOR
  const name = set.placeholder ? "Screenshots (placeholder)" : "Screenshots"
  return {
    markers: {
      id: SHOT_LAYER, label: `${name} (${set.shots.length})`, style: { color, size: 12 },
      features: set.shots.map((s): OverlayFeature => ({ type: "point", at: shotPose(s).position }))
    },
    view: {
      id: SHOT_VIEW_LAYER, label: `${name}: view cones`, style: { color },
      features: set.shots.flatMap((s) => frustumGlyph(s, set.fov))
    }
  }
}

/** Index into the set's shots for an overlay feature id of a screenshot layer, or undefined for any other layer. */
export const shotIndexForFeature = (featureId: string): number | undefined => {
  const i = featureId.lastIndexOf(":")
  if (i < 0) return undefined
  const layer = featureId.slice(0, i), n = Number(featureId.slice(i + 1))
  if (!Number.isInteger(n) || n < 0) return undefined
  return layer === SHOT_LAYER ? n : layer === SHOT_VIEW_LAYER ? n >> 1 : undefined
}

/** A set plus how to turn a shot's relative file name into a URL. */
export interface ScreenshotSource {
  readonly set: ScreenshotSet
  readonly imageUrl: (file: string) => string
}

export type ParsedScreenshots =
  | { readonly ok: true; readonly set: ScreenshotSet; readonly warnings: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: string }

/**
 * Reads an `index.json`: schema, major version 1 and the structural rules. A set for another map or game build is
 * rejected (its poses do not fit this geometry); shots whose read-back pose strayed from the requested one are kept
 * and reported as warnings, since the pose shown is the read-back one.
 */
export const parseScreenshotSet = (text: string, expect: { readonly mapName?: string; readonly gameBuildId?: string } = {}): ParsedScreenshots => {
  let json: unknown
  try { json = JSON.parse(text) } catch (e) { return { ok: false, error: `not valid JSON: ${(e as Error).message}` } }
  let set: ScreenshotSet
  try {
    set = Effect.runSync(decodeVersioned(ScreenshotSet, 1)(json))
  } catch (e) {
    return { ok: false, error: `not a valid screenshot set: ${e instanceof Error ? e.message : String(e)}` }
  }
  const expected = { ...(expect.mapName ? { mapName: expect.mapName } : {}), ...(expect.gameBuildId ? { gameBuildId: expect.gameBuildId } : {}) }
  const errors = validateScreenshotSet(set, { positionTolerance: Infinity, angleTolerance: Infinity, expect: expected })
  if (errors.length) return { ok: false, error: errors.join("; ") }
  return { ok: true, set, warnings: validateScreenshotSet(set) }
}

/** One-line summary of a shot's pose and how far the game's read-back pose strayed. */
export const describeShot = (shot: Shot): { readonly title: string; readonly pose: string; readonly drift: string | undefined } => {
  const p = shotPose(shot)
  const e = poseError(shot)
  const f = (n: number) => n.toFixed(0)
  return {
    title: shot.group ? `${shot.id} (${shot.group})` : shot.id,
    pose: `at ${p.position.map(f).join(", ")}, pitch ${f(p.angles[0])}° yaw ${f(p.angles[1])}°`,
    drift: e && (e.position > 8 || e.angle > 1) ? `read-back pose is ${e.position.toFixed(1)} units and ${e.angle.toFixed(1)}° off the request` : undefined
  }
}
