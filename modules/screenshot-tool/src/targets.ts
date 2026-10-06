import { AnnotationDocument, acceptedRecords, MetadataBundle, validateAnnotationDocument, verifyMetadataBundle, type Aabb, type MetadataRecord, type Vec3 } from "@deadlock-query/contracts"
import { Schema } from "effect"
import { buildPlan, PlanError, type PlanMeta, type ShotPlan, type ShotSpec } from "./plan.ts"

/** A point of interest the camera should frame: an annotation, a creep camp, an orb spawn. */
export interface Target {
  readonly id: string
  readonly at: Vec3
}

export interface Skipped { readonly id: string; readonly reason: string }

/** Is the straight line between two world points blocked by geometry? Supplied by a collision query; absent means "unknown, assume clear". */
export interface Occlusion {
  readonly blocked: (from: Vec3, to: Vec3) => boolean
}

const parse = <A>(schema: Schema.Decoder<A>, input: unknown, what: string): A => {
  try { return Schema.decodeUnknownSync(schema)(input) } catch (e) {
    throw new PlanError([`not ${what}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`])
  }
}

export interface Extracted { readonly targets: Target[]; readonly skipped: Skipped[]; readonly mapName?: string | undefined; readonly gameBuildId?: string | undefined }

/** Point and label annotations become targets; lines, polygons and measures have no single place to look at and are reported as skipped. */
export const targetsFromAnnotations = (input: unknown, opts: { readonly layer?: string | undefined } = {}): Extracted => {
  const doc = parse(AnnotationDocument, input, "an annotation document")
  const problems = validateAnnotationDocument(doc)
  if (problems.length > 0) throw new PlanError(problems)
  const targets: Target[] = [], skipped: Skipped[] = []
  for (const a of doc.annotations) {
    if (opts.layer !== undefined && a.layer !== opts.layer) continue
    if (a.kind === "point" || a.kind === "label") targets.push({ id: a.id, at: a.points[0]! })
    else skipped.push({ id: a.id, reason: `${a.kind} annotations have no single point to frame` })
  }
  return { targets, skipped, mapName: doc.mapName, gameBuildId: doc.gameBuildId }
}

const positionOf = (r: MetadataRecord): Vec3 | undefined => {
  switch (r.kind) {
    case "creepCamp": case "sinnersSacrifice": case "healingOrb": return r.position
    case "custom": return r.geometry.type === "point" ? r.geometry.at : undefined
    default: return undefined
  }
}

/** Accepted point-like records (creep camps, Sinner's Sacrifice, healing orbs, custom points); `allStatuses` also takes proposed ones. */
export const targetsFromMetadata = (input: unknown, opts: { readonly allStatuses?: boolean } = {}): Extracted => {
  const bundle = parse(MetadataBundle, input, "a metadata bundle")
  if (!verifyMetadataBundle(bundle)) throw new PlanError(["the metadata bundle's contentHash does not match its records (edited or truncated?)"])
  const targets: Target[] = [], skipped: Skipped[] = []
  for (const r of opts.allStatuses ? bundle.records : acceptedRecords(bundle)) {
    const at = positionOf(r)
    if (at) targets.push({ id: `${r.kind}-${r.id}`, at })
    else skipped.push({ id: `${r.kind}-${r.id}`, reason: `${r.kind} records have no single point to frame` })
  }
  return { targets, skipped, mapName: bundle.mapName, gameBuildId: bundle.gameBuildId }
}

export interface StandoffOptions {
  /** Camera positions per target, evenly spaced around it (default 3). */
  readonly standoffs?: number
  /** Distance from the target in world units (default 600). */
  readonly distance?: number
  /** Camera height above the target's z (default 64, roughly eye height). */
  readonly eyeHeight?: number
  /** Rotates the first bearing, degrees (default 0: first camera on the +X side). */
  readonly bearingOffset?: number
  /** Cameras outside these bounds (xy) are not used. */
  readonly bounds?: Aabb
  readonly occlusion?: Occlusion
  /**
   * The line of sight is tested to this far above the target (default 32), because annotation points usually sit on the
   * floor and a ray ending exactly on a floor triangle would count as blocked. The camera still aims at the target itself.
   */
  readonly sightLift?: number
}

/** When a view is blocked, try the same bearing closer in before giving up on it. */
const DISTANCE_STEPS = [1, 0.6, 0.35] as const

const round = (v: number): number => Math.round(v * 1000) / 1000 + 0
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "target"

export interface StandoffResult { readonly plan: ShotPlan; readonly skipped: Skipped[]; readonly warnings: string[] }

/**
 * For each target, `standoffs` cameras around it that look straight at it (`lookAt`). With an `occlusion`, a camera whose line
 * of sight is blocked moves closer along the same bearing; if no distance works the camera is dropped, and a target left with
 * no camera is reported in `skipped`. Without one, every candidate is accepted: the result says so in `warnings`.
 */
export const standoffPlan = (meta: PlanMeta, targets: ReadonlyArray<Target>, o: StandoffOptions = {}): StandoffResult => {
  const count = o.standoffs ?? 3, distance = o.distance ?? 600, eye = o.eyeHeight ?? 64, offset = o.bearingOffset ?? 0
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new PlanError([`standoffs must be an integer from 1 to 16, got ${count}`])
  if (!(distance > 0)) throw new PlanError([`distance must be positive, got ${distance}`])
  const lift = o.sightLift ?? 32
  const skipped: Skipped[] = [], warnings: string[] = []
  if (o.occlusion === undefined) warnings.push("no collision data: lines of sight were not checked, some shots may face a wall")
  const inBounds = (p: Vec3) => o.bounds === undefined || (p[0] >= o.bounds.min[0] && p[0] <= o.bounds.max[0] && p[1] >= o.bounds.min[1] && p[1] <= o.bounds.max[1])

  const used = new Map<string, number>()
  const shots: ShotSpec[] = []
  for (const t of targets) {
    let base = safeId(t.id)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    if (n > 1) base = `${base}-${n}`
    const group = base
    let kept = 0, outOfBounds = 0, blocked = 0
    for (let k = 0; k < count; k++) {
      const bearing = ((offset + (k * 360) / count) * Math.PI) / 180
      let chosen: Vec3 | undefined
      for (const step of DISTANCE_STEPS) {
        const d = distance * step
        const pos: Vec3 = [round(t.at[0] + d * Math.cos(bearing)), round(t.at[1] + d * Math.sin(bearing)), round(t.at[2] + eye)]
        if (!inBounds(pos)) { outOfBounds++; continue }
        if (o.occlusion?.blocked(pos, [t.at[0], t.at[1], t.at[2] + lift])) { blocked++; continue }
        chosen = pos
        break
      }
      if (chosen === undefined) continue
      kept++
      shots.push({ id: `${base}-s${k + 1}`, group, position: chosen, lookAt: t.at })
    }
    if (kept === 0) skipped.push({ id: t.id, reason: `no usable camera position (${blocked} blocked, ${outOfBounds} outside the map bounds)` })
    else if (kept < count) warnings.push(`${t.id}: only ${kept} of ${count} camera positions were usable`)
  }
  if (shots.length === 0) throw new PlanError(["no shots: " + (targets.length === 0 ? "there are no targets" : skipped.map((s) => `${s.id}: ${s.reason}`).join("; "))])
  return { plan: buildPlan(meta, shots), skipped, warnings }
}
