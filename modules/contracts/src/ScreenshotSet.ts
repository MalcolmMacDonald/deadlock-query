import { Schema } from "effect"
import { SCHEMA_VERSION, Vec3S } from "./MapBundle.ts"
import { distance, type Vec3 } from "./Space.ts"

/**
 * Reference screenshots taken in the running game by screenshot-tool (`dlq-shoot shoot`) and shown by map-viewer as
 * street-view markers. Poses are world space, Source units, Z-up; angles are Source `setang` order (pitch, yaw, roll)
 * in degrees. `index.json` in `data/screenshots/<gameBuildId>/` is a `ScreenshotSet`; file paths are relative to it.
 */

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/))
const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

export const ShotPose = Schema.Struct({
  position: Vec3S,
  /** Source angles (pitch, yaw, roll) in degrees. */
  angles: Vec3S
})
export type ShotPose = typeof ShotPose.Type

export const Shot = Schema.Struct({
  id: Id,
  /** Plan group, e.g. the annotation or grid cell the shot belongs to. */
  group: Schema.optionalKey(Id),
  /** The pose the plan asked for. */
  requested: ShotPose,
  /** Pose read back from the game after `setpos`/`setang` (`getpos`); absent when the run could not read it back. */
  actual: Schema.optionalKey(ShotPose),
  /** Point the camera was aimed at, when the plan was given one instead of angles. */
  lookAt: Schema.optionalKey(Vec3S),
  file: Schema.String,
  thumbnail: Schema.optionalKey(Schema.String),
  bytes: Schema.Number,
  sha256: Schema.String,
  /** Pixel size of the image file. */
  width: PositiveInt,
  height: PositiveInt,
  capturedAt: Timestamp
})
export type Shot = typeof Shot.Type

export const ScreenshotSet = Schema.Struct({
  schemaVersion: Schema.String,
  gameBuildId: Schema.String,
  mapName: Schema.String,
  /** Vertical field of view in degrees, fixed for the whole run. */
  fov: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(180)),
  hideHud: Schema.Boolean,
  /** True for a dry run with the fake console: the images are placeholders and the poses are not real. */
  placeholder: Schema.optionalKey(Schema.Boolean),
  tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, version: Schema.String })),
  shots: Schema.Array(Shot)
})
export type ScreenshotSet = typeof ScreenshotSet.Type

export const makeScreenshotSet = (
  meta: Omit<ScreenshotSet, "schemaVersion" | "shots">, shots: ReadonlyArray<Shot>
): ScreenshotSet => ({ schemaVersion: SCHEMA_VERSION, ...meta, shots: [...shots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) })

/** Distance in angle between two degree values, 0..180 (handles wrap-around at 360). */
const angleDiff = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180)
  return d
}

/** How far the game's read-back pose is from the requested one: world units, and the largest angle error in degrees. */
export const poseError = (shot: Pick<Shot, "requested" | "actual">): { readonly position: number; readonly angle: number } | undefined =>
  shot.actual === undefined ? undefined : {
    position: distance(shot.requested.position, shot.actual.position),
    angle: Math.max(...shot.requested.angles.map((a, i) => angleDiff(a, shot.actual!.angles[i]!)))
  }

export interface ScreenshotValidationOptions {
  /** Largest accepted difference between requested and read-back position (default 8 units). */
  readonly positionTolerance?: number
  /** Largest accepted angle difference in degrees (default 1). */
  readonly angleTolerance?: number
  readonly expect?: { readonly gameBuildId?: string; readonly mapName?: string }
}

/**
 * Cross-field rules the schema cannot express: unique shot ids and files, matching build and map, and read-back poses
 * within tolerance (a shot whose pose was not honoured does not show what the plan wanted). A shot with no
 * read-back pose passes: `verify` reports those separately.
 */
export const validateScreenshotSet = (set: ScreenshotSet, opts: ScreenshotValidationOptions = {}): ReadonlyArray<string> => {
  const errors: string[] = []
  const posTol = opts.positionTolerance ?? 8
  const angTol = opts.angleTolerance ?? 1
  if (opts.expect?.gameBuildId !== undefined && set.gameBuildId !== opts.expect.gameBuildId) errors.push(`gameBuildId "${set.gameBuildId}" is not "${opts.expect.gameBuildId}"`)
  if (opts.expect?.mapName !== undefined && set.mapName !== opts.expect.mapName) errors.push(`mapName "${set.mapName}" is not "${opts.expect.mapName}"`)
  const ids = new Set<string>(), files = new Set<string>()
  for (const s of set.shots) {
    if (ids.has(s.id)) errors.push(`duplicate shot id "${s.id}"`)
    ids.add(s.id)
    if (files.has(s.file)) errors.push(`shots share the file "${s.file}"`)
    files.add(s.file)
    const e = poseError(s)
    if (e && e.position > posTol) errors.push(`shot "${s.id}": position is ${e.position.toFixed(1)} units off the requested pose`)
    if (e && e.angle > angTol) errors.push(`shot "${s.id}": angle is ${e.angle.toFixed(1)} degrees off the requested pose`)
  }
  return errors
}

/** Shots taken within `radius` of a world point, nearest first: how the viewer finds the imagery for a marker. */
export const shotsNear = (set: Pick<ScreenshotSet, "shots">, point: Vec3, radius: number): ReadonlyArray<Shot> =>
  set.shots
    .map((s) => ({ s, d: distance((s.actual ?? s.requested).position, point) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => a.d - b.d || (a.s.id < b.s.id ? -1 : 1))
    .map((x) => x.s)
