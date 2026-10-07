import { Vec3 } from "./Vec3.ts"
import { UNITS_PER_METER } from "./units.ts"
import { requireSpatial } from "./active.ts"
import type { MovementModelLike, NavInput } from "./spatial.ts"

/**
 * Seconds of travel time (identity, for readability: travel-time functions work in seconds).
 * @example map.healingOrbs.withinTravelTime(seconds(10), map.guardians)
 * @category Units
 */
export const seconds = (n: number): number => n

type Field = { costAt(p: readonly [number, number, number], maxSnap?: number): number; readonly costs?: ArrayLike<number> }
/** Floating pickups on the real map hover up to ~855 units above the mesh, so the default must cover them (200 left every orb unreachable). */
const DEFAULT_MAX_SNAP = 900
const MAX_FIELDS = 256
/** Cache budget in bytes of per-polygon costs: a real-map field is ~0.7 MB (85k polygons), so 256 entries would be ~175 MB. */
const MAX_FIELD_BYTES = 96 * 1024 * 1024
const MIN_FIELDS = 8
const bytesOf = (f: Field): number => (f.costs?.length ?? 0) * 8
let fieldBytes = 0
const fields = new Map<string, Field>()
let fieldsFor: NavInput | undefined

const need = (what: string): NavInput => {
  const nav = requireSpatial(what).nav
  if (!nav) throw new Error(`${what} needs a navmesh: pass { spatial: { raycaster, nav: { mesh } } } to MapContext.fromBundle`)
  return nav
}

/**
 * Link speeds in force: the defaults under whatever `nav.linkSpeeds` sets (a kind set to 0 is switched off).
 * `navConnection` links come from the game's own nav (jumps, drops and climbs it lets a walker make), so they default to
 * the walking speed; without an entry on-foot routes cannot use them (34 of 115 base/lane/camp entities are otherwise
 * unreachable from a patron on the real map).
 * @internal
 */
export const linkSpeedsOf = (nav: Pick<NavInput, "heroSpeed" | "linkSpeeds">): Readonly<Record<string, number>> => ({
  zipline: 15 * UNITS_PER_METER,
  navConnection: nav.heroSpeed ?? 7 * UNITS_PER_METER,
  ...nav.linkSpeeds
})

const timeModel = (nav: NavInput): MovementModelLike => ({ speed: nav.heroSpeed ?? 7 * UNITS_PER_METER, linkSpeeds: linkSpeedsOf(nav) })
/** Unit speeds everywhere: cost is path length in Source units. */
const distanceModel = (nav: NavInput): MovementModelLike => ({ speed: 1, linkSpeeds: Object.fromEntries(Object.keys(timeModel(nav).linkSpeeds ?? {}).map((k) => [k, 1])) })
const snap = (nav: NavInput): number => nav.maxSnap ?? DEFAULT_MAX_SNAP

/** Distance fields are memoised per (model, source set); cleared when a new nav backend is active. */
const fieldFor = (nav: NavInput, mode: "time" | "distance", sources: ReadonlyArray<Vec3>): Field => {
  if (fieldsFor !== nav) { fields.clear(); fieldBytes = 0; fieldsFor = nav }
  const key = `${mode}|${sources.map((s) => `${s.x},${s.y},${s.z}`).join(";")}`
  const hit = fields.get(key)
  if (hit) { fields.delete(key); fields.set(key, hit); return hit }
  const f = nav.mesh.distanceField(sources.map((s) => s.toArray()), mode === "time" ? timeModel(nav) : distanceModel(nav))
  const add = bytesOf(f)
  while (fields.size >= MAX_FIELDS || (fields.size >= MIN_FIELDS && fieldBytes + add > MAX_FIELD_BYTES)) {
    const oldest = fields.keys().next().value!
    fieldBytes -= bytesOf(fields.get(oldest)!)
    fields.delete(oldest)
  }
  fields.set(key, f); fieldBytes += add
  return f
}

/** @internal */
export const travelCost = (what: string, mode: "time" | "distance", from: Vec3, to: Vec3): number => {
  const nav = need(what)
  const f = fieldFor(nav, mode, [from])
  return f.costAt(to.toArray(), snap(nav))
}

/** @internal Fields over a source set, for withinTravelTime. */
export const timeField = (what: string, sources: ReadonlyArray<Vec3>): ((p: Vec3) => number) => {
  const nav = need(what)
  const f = fieldFor(nav, "time", sources)
  return (p) => f.costAt(p.toArray(), snap(nav))
}

/** A route over the navmesh. @category Navigation */
export interface NavRoute {
  /** Waypoints from start to end. */
  readonly points: ReadonlyArray<Vec3>
  /** Travel time in seconds. */
  readonly time: number
}

/**
 * Navigation queries (`map.nav`), over the baked navmesh with ziplines and overrides.
 * Costs are approximate: polygon-centroid hops, so expect error of about one polygon size.
 * @example map.nav.path(map.guardians.first()!.position, map.healingOrbs.first()!.position)
 * @category Navigation
 */
export class NavApi {
  /**
   * Quickest route between two points, or `undefined` when unreachable. One A* search. `radius` (Source units) keeps
   * the waypoints that far from wall corners; the route and `time` are unchanged.
   * @example map.nav.path(vec(0, 0, 0), vec(1000, 0, 0))?.time
   * @category Navigation
   */
  path(from: Vec3, to: Vec3, opts: { radius?: number } = {}): NavRoute | undefined {
    const nav = need("nav.path()")
    const r = nav.mesh.findPath(from.toArray(), to.toArray(), timeModel(nav), opts.radius ? { radius: opts.radius } : undefined)
    return r ? { points: r.points.map((p) => new Vec3(p[0], p[1], p[2])), time: r.cost } : undefined
  }

  /**
   * True when the straight segment between two points stays on the walkable mesh (sampled; ignores off-mesh links).
   * @example map.nav.walkable(map.guardians.first()!.position, map.patrons.first()!.position)
   * @category Navigation
   */
  walkable(a: Vec3, b: Vec3): boolean {
    const nav = need("nav.walkable()")
    if (!nav.mesh.walkable) throw new Error("nav.walkable() needs a navmesh with a walkable() method (spatial-core NavMesh)")
    return nav.mesh.walkable(a.toArray(), b.toArray())
  }

  /**
   * Travel time in seconds from every source to a point (the quickest source), `Infinity` if
   * unreachable. The field over the source set is computed once and cached.
   * @example map.nav.timeFrom(map.guardians.select(g => g.position))(vec(0, 0, 0))
   * @category Navigation
   */
  timeFrom(sources: Vec3 | Iterable<Vec3>): (to: Vec3) => number {
    return timeField("nav.timeFrom()", sources instanceof Vec3 ? [sources] : [...sources])
  }
}
