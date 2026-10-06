import { hasSpatial } from "./active.ts"
import { Seq } from "./Seq.ts"
import { timeField } from "./nav.ts"
import { Vec3 } from "./Vec3.ts"
import type { VisibleOpts } from "./spatial.ts"
import type { RecordProvenance } from "./metadata.ts"

/**
 * Lane colour. Lane numbers 1-3 map to colours through `MapSettings.laneColors`.
 * @category Entities
 */
export type Lane = "yellow" | "blue" | "purple"

/**
 * Normalised entity kinds exposed to queries.
 * @category Entities
 */
export type EntityKind =
  | "guardian" | "walker" | "patron" | "barracks" | "baseSentry" | "healingOrb" | "creepCamp"
  | "zipline" | "jumpPad" | "climbRope" | "interior" | "shop" | "spawn" | "trooperSpawn"
  | "capturePoint" | "powerup" | "crate" | "laneMarker" | "sinnersSacrifice"

/** Structural shape of an extractor entity (matches contracts `Entity`).
 * @category Entities */
export interface RawEntity {
  readonly id: string
  readonly class: string
  readonly kind?: string
  readonly position: readonly [number, number, number]
  readonly rotation?: readonly [number, number, number]
  readonly team?: number
  readonly lane?: number
  readonly properties: Readonly<Record<string, unknown>>
}

/**
 * A map entity with a {@link Vec3} position.
 * @example map.guardians.first()!.position.distanceTo(map.healingOrbs.first()!.position)
 * @category Entities
 */
export class MapEntity {
  constructor(
    readonly id: string,
    /** Source classname, e.g. `citadel_pickup_spawner`. */
    readonly className: string,
    readonly kind: EntityKind | undefined,
    readonly position: Vec3,
    readonly team: number | undefined,
    readonly lane: Lane | undefined,
    /** Lane number (1-3) as in the game data. */
    readonly laneNumber: number | undefined,
    /** Raw extra key/values from the extractor. */
    readonly properties: Readonly<Record<string, unknown>>,
    /** `"metadata"` for entities merged from accepted metadata, `"extractor"` otherwise. */
    readonly source: "extractor" | "metadata" = "extractor",
    /** Submitter and reviewer of a metadata entity; `undefined` for extractor entities. */
    readonly provenance?: RecordProvenance
  ) {}

  /**
   * Straight-line distance to a point or another entity, in Source units.
   * @example map.guardians.first()!.distanceTo(map.healingOrbs.first()!)
   * @category Entities
   */
  distanceTo(other: MapEntity | Vec3): number {
    return this.position.distanceTo(other instanceof Vec3 ? other : other.position)
  }
}

/** Things that have a location: points and entities. @category Entities */
export type Locatable = MapEntity | Vec3

const where = (x: Locatable): Vec3 => (x instanceof Vec3 ? x : x.position)

/**
 * A square XY cell of a regular grid anchored at the origin (`ix = floor(x / cell)`).
 * @category Entities
 */
export interface Region {
  readonly ix: number
  readonly iy: number
  /** Cell centre at z = 0. */
  readonly center: Vec3
  /** Stable text key, e.g. `"-1,2"`. */
  readonly key: string
}

/**
 * The grid cell containing a point or entity.
 * @example regionOf(vec(1250, -300, 0), meters(50)).key
 * @category Entities
 */
export const regionOf = (at: Locatable, cellSize: number): Region => {
  if (!(cellSize > 0)) throw new Error("regionOf(cellSize): cellSize must be > 0")
  const p = where(at)
  const ix = Math.floor(p.x / cellSize), iy = Math.floor(p.y / cellSize)
  return { ix, iy, center: new Vec3((ix + 0.5) * cellSize, (iy + 0.5) * cellSize, 0), key: `${ix},${iy}` }
}

/**
 * A lazy collection of entities with spatial filters. `where`, `take`, `skip` and `distinct`
 * keep the entity helpers available.
 * @example map.healingOrbs.within(meters(40), map.guardians)
 * @category Entities
 */
export class EntityList extends Seq<MapEntity> {
  protected override make(source: Iterable<MapEntity>): EntityList {
    return new EntityList(source)
  }

  override where(predicate: (item: MapEntity, index: number) => boolean): EntityList {
    return super.where(predicate) as EntityList
  }

  override take(n: number): EntityList {
    return super.take(n) as EntityList
  }

  override skip(n: number): EntityList {
    return super.skip(n) as EntityList
  }

  override distinct(key?: (item: MapEntity) => unknown): EntityList {
    return super.distinct(key) as EntityList
  }

  /**
   * Entities in a lane, by colour or by lane number (1-3).
   * @example map.guardians.inLane("yellow")
   * @category Entities
   */
  inLane(lane: Lane | 1 | 2 | 3): EntityList {
    return this.where((e) => (typeof lane === "number" ? e.laneNumber === lane : e.lane === lane))
  }

  /**
   * Entities from one source: the game data (`"extractor"`) or accepted user metadata (`"metadata"`).
   * @example map.creepCamps.fromSource("metadata").select(c => c.provenance?.submitter?.name)
   * @category Entities
   */
  fromSource(source: "extractor" | "metadata"): EntityList {
    return this.where((e) => e.source === source)
  }

  /**
   * Entities belonging to a team number (as in the game data, e.g. 2 or 3).
   * @example map.guardians.onTeam(2)
   * @category Entities
   */
  onTeam(team: number): EntityList {
    return this.where((e) => e.team === team)
  }

  /**
   * Entities within `range` Source units (3D) of any of the given points/entities.
   * O(n·m); use {@link meters} for metric ranges.
   * @example map.healingOrbs.within(meters(40), map.guardians.inLane("yellow"))
   * @category Entities
   */
  within(range: number, of: Locatable | Iterable<Locatable>): EntityList {
    const targets = (of instanceof Vec3 || of instanceof MapEntity ? [of] : [...of]).map(where)
    return this.where((e) => targets.some((t) => e.position.distanceTo(t) <= range))
  }

  /**
   * Entities reachable within `time` seconds from any of the given points/entities
   * (navmesh + ziplines). One cached distance field over all sources: O(polygons log polygons).
   * @example map.healingOrbs.withinTravelTime(seconds(10), map.guardians.inLane("yellow"))
   * @category Entities
   */
  withinTravelTime(time: number, of: Locatable | Iterable<Locatable>): EntityList {
    const costAt = timeField("withinTravelTime()", (of instanceof Vec3 || of instanceof MapEntity ? [of] : [...of]).map(where))
    return this.where((e) => costAt(e.position) <= time)
  }

  /**
   * Entities at least `minHeight` Source units high: elevation above the map bounds' minimum
   * z ({@link Vec3.height}) when a spatial backend is loaded, absolute z otherwise.
   * @example map.creepCamps.highGround(800)
   * @category Entities
   */
  highGround(minHeight: number): EntityList {
    return this.where(hasSpatial() ? (e) => e.position.height() >= minHeight : (e) => e.position.z >= minHeight)
  }

  /**
   * Entities visible from any of the given viewpoints (owner-authored semantics).
   * O(n·m) ray tests.
   * @example map.creepCamps.visibleFrom(map.guardians)
   * @category Entities
   */
  visibleFrom(from: Locatable | Iterable<Locatable>, opts?: VisibleOpts): EntityList {
    const pts = (from instanceof Vec3 || from instanceof MapEntity ? [from] : [...from]).map(where)
    return this.where((e) => e.position.visibleFrom(pts, opts))
  }

  /**
   * The entity nearest to a point or entity, or `undefined` when empty.
   * @example map.healingOrbs.closest(map.guardians.first()!)
   * @category Entities
   */
  closest(to: Locatable): MapEntity | undefined {
    const p = where(to)
    return this.min((e) => e.position.distanceTo(p))
  }

  /**
   * The `n` entities nearest to a point or entity, nearest first (ties keep list order).
   * @example map.healingOrbs.closestN(map.guardians.first()!, 3)
   * @category Entities
   */
  closestN(to: Locatable, n: number): MapEntity[] {
    const p = where(to)
    return this.orderBy((e) => e.position.distanceTo(p)).take(n).toArray()
  }

  /**
   * Group entities by the XY grid cell (side `cellSize` Source units) they sit in.
   * Groups are ordered by `ix` then `iy`, so output is deterministic.
   * @example map.creepCamps.groupByRegion(meters(100)).select(g => [g.region.key, g.items.length])
   * @category Entities
   */
  groupByRegion(cellSize: number): Seq<{ readonly region: Region; readonly items: MapEntity[] }> {
    const src = this
    return new Seq({
      *[Symbol.iterator]() {
        const cells = new Map<string, { region: Region; items: MapEntity[] }>()
        for (const e of src) {
          const region = regionOf(e, cellSize)
          const g = cells.get(region.key)
          if (g) g.items.push(e)
          else cells.set(region.key, { region, items: [e] })
        }
        yield* [...cells.values()].sort((a, b) => a.region.ix - b.region.ix || a.region.iy - b.region.iy)
      },
    })
  }
}
