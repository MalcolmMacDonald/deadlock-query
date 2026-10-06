import { Seq } from "./Seq.ts"
import { Vec3 } from "./Vec3.ts"

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
  | "capturePoint" | "powerup" | "crate" | "laneMarker"

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
    readonly properties: Readonly<Record<string, unknown>>
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
   * Entities at least `minHeight` Source units above the ground plane (z).
   * Placeholder: absolute z; terrain-relative height arrives with spatial-core wiring (M3).
   * @example map.creepCamps.highGround(300)
   * @category Entities
   */
  highGround(minHeight: number): EntityList {
    return this.where((e) => e.position.z >= minHeight)
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
}
