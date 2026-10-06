import { SCHEMA_VERSION, Vec3S, type Vec3 } from "@deadlock-query/contracts"
import { Schema } from "effect"

/**
 * A shot plan is the input of `shoot`: where to put the camera and what to aim at, nothing about files or results.
 * Poses are world space, Source units, Z-up; `angles` are Source `setang` order (pitch, yaw, roll) in degrees.
 */
const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/))

export const ShotSpec = Schema.Struct({
  /** Becomes the image file name, so it is restricted to `[A-Za-z0-9._-]`. */
  id: Name,
  position: Vec3S,
  /** Exactly one of `angles` and `lookAt` is set. */
  angles: Schema.optionalKey(Vec3S),
  lookAt: Schema.optionalKey(Vec3S),
  group: Schema.optionalKey(Name)
})
export type ShotSpec = typeof ShotSpec.Type

export const ShotPlan = Schema.Struct({
  schemaVersion: Schema.String,
  gameBuildId: Schema.optionalKey(Schema.String),
  map: Schema.String,
  resolution: Schema.Struct({
    width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
  }),
  /** Vertical field of view in degrees. */
  fov: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(180)),
  hideHud: Schema.Boolean,
  shots: Schema.Array(ShotSpec)
})
export type ShotPlan = typeof ShotPlan.Type

export class PlanError extends Error {
  readonly _tag = "PlanError"
  constructor(readonly problems: ReadonlyArray<string>) {
    super(problems.join("\n"))
  }
}

/** Cross-field rules the schema cannot express. Empty when the plan is usable. */
export const validatePlan = (plan: ShotPlan): ReadonlyArray<string> => {
  const problems: string[] = []
  if (plan.shots.length === 0) problems.push("plan has no shots")
  const seen = new Set<string>()
  for (const s of plan.shots) {
    if (seen.has(s.id)) problems.push(`duplicate shot id "${s.id}"`)
    seen.add(s.id)
    if ((s.angles === undefined) === (s.lookAt === undefined)) problems.push(`shot "${s.id}": set exactly one of angles and lookAt`)
    if (s.lookAt !== undefined && s.lookAt.every((v, i) => v === s.position[i])) problems.push(`shot "${s.id}": lookAt equals position`)
  }
  return problems
}

/** Decode and validate untrusted JSON; throws `PlanError` listing every problem. */
export const parsePlan = (input: unknown): ShotPlan => {
  let plan: ShotPlan
  try {
    plan = Schema.decodeUnknownSync(ShotPlan)(input)
  } catch (e) {
    throw new PlanError([`not a shot plan: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`])
  }
  const problems = validatePlan(plan)
  if (problems.length > 0) throw new PlanError(problems)
  return plan
}

const round = (v: number): number => Math.round(v * 1000) / 1000 + 0

/** Source angles (pitch, yaw, 0) that aim a camera at `target`; positive pitch looks down. */
export const lookAtAngles = (from: Vec3, target: Vec3): Vec3 => {
  const dx = target[0] - from[0], dy = target[1] - from[1], dz = target[2] - from[2]
  const yaw = (Math.atan2(dy, dx) * 180) / Math.PI
  const pitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI
  return [round(pitch), round((yaw + 360) % 360), 0]
}

/** The angles to send to the game for a shot, whichever way the plan gave them. */
export const shotAngles = (s: ShotSpec): Vec3 => s.angles ?? lookAtAngles(s.position, s.lookAt!)

export interface PlanMeta {
  readonly map: string
  readonly gameBuildId?: string | undefined
  readonly resolution?: { readonly width: number; readonly height: number }
  readonly fov?: number
  readonly hideHud?: boolean
}

export const DEFAULT_RESOLUTION = { width: 1920, height: 1080 } as const
export const DEFAULT_FOV = 90
/** Refuse plans that would take hours by accident. */
export const MAX_SHOTS = 5000

const make = (meta: PlanMeta, shots: ShotSpec[]): ShotPlan => {
  if (shots.length > MAX_SHOTS) throw new PlanError([`plan would have ${shots.length} shots (max ${MAX_SHOTS}); use a larger spacing or fewer yaws`])
  return parsePlan({
    schemaVersion: SCHEMA_VERSION,
    ...(meta.gameBuildId !== undefined ? { gameBuildId: meta.gameBuildId } : {}),
    map: meta.map,
    resolution: meta.resolution ?? DEFAULT_RESOLUTION,
    fov: meta.fov ?? DEFAULT_FOV,
    hideHud: meta.hideHud ?? true,
    shots
  })
}

/** `count` yaws evenly spaced over 360 degrees starting at 0. */
export const yawsOf = (count: number): number[] => {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new PlanError([`yaws must be an integer from 1 to 64, got ${count}`])
  return Array.from({ length: count }, (_, k) => round((k * 360) / count))
}

const yawTag = (yaw: number): string => `y${String(Math.round(yaw)).padStart(3, "0")}`

export interface RingOptions { readonly at: ReadonlyArray<Vec3>; readonly yaws?: number; readonly pitch?: number }

/** One group per position, `yaws` shots turning on the spot (default 8, panorama-ready). */
export const ringPlan = (meta: PlanMeta, o: RingOptions): ShotPlan => {
  const yaws = yawsOf(o.yaws ?? 8)
  const pitch = o.pitch ?? 0
  const shots = o.at.flatMap((position, i): ShotSpec[] => {
    const group = `ring-${String(i + 1).padStart(3, "0")}`
    return yaws.map((yaw) => ({ id: `${group}-${yawTag(yaw)}`, group, position: position.map(round) as unknown as Vec3, angles: [pitch, yaw, 0] }))
  })
  return make(meta, shots)
}

export interface GridOptions {
  /** World xy rectangle: minX, minY, maxX, maxY. */
  readonly bounds: readonly [number, number, number, number]
  readonly spacing: number
  /** Camera height in world units (absolute z, same for every cell). */
  readonly z: number
  readonly yaws?: number
  readonly pitch?: number
}

/** Cell centres of a regular grid over `bounds`, row-major (y then x), `yaws` shots per cell. */
export const gridPlan = (meta: PlanMeta, o: GridOptions): ShotPlan => {
  const [minX, minY, maxX, maxY] = o.bounds
  if (!(o.spacing > 0)) throw new PlanError([`spacing must be positive, got ${o.spacing}`])
  if (!(maxX > minX && maxY > minY)) throw new PlanError([`bounds must have max > min on both axes, got ${o.bounds.join(",")}`])
  const cols = Math.floor((maxX - minX) / o.spacing), rows = Math.floor((maxY - minY) / o.spacing)
  if (cols < 1 || rows < 1) throw new PlanError([`spacing ${o.spacing} leaves no whole cell in bounds ${o.bounds.join(",")}`])
  const yaws = yawsOf(o.yaws ?? 4)
  const pitch = o.pitch ?? 0
  // Centre the lattice in the bounds so the margin is split evenly.
  const x0 = minX + ((maxX - minX) - (cols - 1) * o.spacing) / 2
  const y0 = minY + ((maxY - minY) - (rows - 1) * o.spacing) / 2
  const shots: ShotSpec[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const group = `grid-r${String(r).padStart(3, "0")}c${String(c).padStart(3, "0")}`
      const position: Vec3 = [round(x0 + c * o.spacing), round(y0 + r * o.spacing), round(o.z)]
      for (const yaw of yaws) shots.push({ id: `${group}-${yawTag(yaw)}`, group, position, angles: [pitch, yaw, 0] })
    }
  }
  return make(meta, shots)
}

/** Canonical text form: stable key order, two-space indent, trailing newline. Same plan in, same bytes out. */
export const serializePlan = (plan: ShotPlan): string =>
  `${JSON.stringify({
    schemaVersion: plan.schemaVersion,
    ...(plan.gameBuildId !== undefined ? { gameBuildId: plan.gameBuildId } : {}),
    map: plan.map,
    resolution: { width: plan.resolution.width, height: plan.resolution.height },
    fov: plan.fov,
    hideHud: plan.hideHud,
    shots: plan.shots.map((s) => ({
      id: s.id,
      ...(s.group !== undefined ? { group: s.group } : {}),
      position: s.position,
      ...(s.angles !== undefined ? { angles: s.angles } : {}),
      ...(s.lookAt !== undefined ? { lookAt: s.lookAt } : {})
    }))
  }, null, 2)}\n`
