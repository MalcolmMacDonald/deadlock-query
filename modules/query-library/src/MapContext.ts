import { EntityList, MapEntity, type EntityKind, type Lane, type RawEntity } from "./entities.ts"
import { Vec3 } from "./Vec3.ts"
import { SampleApi } from "./sample.ts"
import { isProvisional, setActiveSpatial } from "./active.ts"
import type { SpatialInput } from "./spatial.ts"

/**
 * Tunable settings. Defaults are proposals for the project owner to confirm.
 * @category Context
 */
export interface MapSettings {
  /** Lane number -> colour. Proposed default: 1 yellow, 2 blue, 3 purple. */
  readonly laneColors: Readonly<Record<number, Lane>>
}

/** Default {@link MapSettings}. @category Context */
export const DEFAULT_SETTINGS: MapSettings = { laneColors: { 1: "yellow", 2: "blue", 3: "purple" } }

/** What `MapContext.fromBundle` needs from a loaded bundle.
 * @category Context */
export interface BundleInput {
  readonly manifest: { readonly mapName: string; readonly gameBuildId: string }
  readonly entities: ReadonlyArray<RawEntity>
  /** Raycaster + owner semantics. Without it, spatial methods (`height`, `visibleFrom`, `sample`) throw. */
  readonly spatial?: SpatialInput
}

/**
 * The `map` global: typed entity collections for the loaded map bundle.
 * @example map.guardians.inLane("yellow").select(g => map.healingOrbs.closest(g))
 * @category Context
 */
export class MapContext {
  private constructor(
    readonly mapName: string,
    readonly gameBuildId: string,
    private readonly all: ReadonlyArray<MapEntity>,
    readonly settings: MapSettings
  ) {}

  /**
   * Build a context from a loaded bundle (manifest + entities).
   * @example MapContext.fromBundle({ manifest, entities })
   * @category Context
   */
  static fromBundle(bundle: BundleInput, settings: Partial<MapSettings> = {}): MapContext {
    setActiveSpatial(bundle.spatial)
    const s: MapSettings = { ...DEFAULT_SETTINGS, ...settings }
    const all = bundle.entities.map((e) => new MapEntity(
      e.id, e.class, e.kind as EntityKind | undefined, new Vec3(...e.position), e.team,
      e.lane === undefined ? undefined : s.laneColors[e.lane], e.lane, e.properties
    ))
    return new MapContext(bundle.manifest.mapName, bundle.manifest.gameBuildId, all, s)
  }

  /**
   * Every entity of one kind.
   * @example map.ofKind("zipline")
   * @category Context
   */
  ofKind(kind: EntityKind): EntityList {
    return new EntityList(this.all).where((e) => e.kind === kind)
  }

  /** True when results rely on placeholder (non-final) semantics; mark them provisional. @category Context */
  get provisional(): boolean { return isProvisional() }
  /** Point samplers over the map geometry. @category Context */
  get sample(): SampleApi { return new SampleApi() }

  /** Every entity, including classes without a normalised kind. @category Context */
  get entities(): EntityList { return new EntityList(this.all) }
  /** T1 guardians. @category Context */
  get guardians(): EntityList { return this.ofKind("guardian") }
  /** T2 walkers. @category Context */
  get walkers(): EntityList { return this.ofKind("walker") }
  /** T3 patrons. @category Context */
  get patrons(): EntityList { return this.ofKind("patron") }
  /** Healing orb spawners. @category Context */
  get healingOrbs(): EntityList { return this.ofKind("healingOrb") }
  /** Neutral creep camps. @category Context */
  get creepCamps(): EntityList { return this.ofKind("creepCamp") }
  /** Ziplines. @category Context */
  get ziplines(): EntityList { return this.ofKind("zipline") }
}
