import { EntityList, MapEntity, type EntityKind, type Lane, type RawEntity } from "./entities.ts"
import { Vec3 } from "./Vec3.ts"
import { NavApi } from "./nav.ts"
import { SampleApi } from "./sample.ts"
import { isProvisional, setActiveSpatial } from "./active.ts"
import type { SpatialInput } from "./spatial.ts"
import { mergeMetadata, type MetadataInput, type MetadataReport } from "./metadata.ts"

/**
 * Tunable settings. Defaults are proposals for the project owner to confirm.
 * @category Context
 */
export interface MapSettings {
  /** Lane number -> colour. Default: 1 yellow, 2 blue (middle), 3 green (the game data calls it "purple"). */
  readonly laneColors: Readonly<Record<number, Lane>>
  /** A metadata camp or orb within this many Source units of an extractor entity of the same kind is a duplicate and is skipped. Proposed default 150. */
  readonly metadataDedupeRadius: number
  /** A region only affects navmesh polygons whose centroid is within this many units of its `floorZ` (separates stacked floors). Proposed default 250. */
  readonly regionZTolerance: number
}

/** Default {@link MapSettings}. @category Context */
export const DEFAULT_SETTINGS: MapSettings = { laneColors: { 1: "yellow", 2: "blue", 3: "green" }, metadataDedupeRadius: 150, regionZTolerance: 250 }

/** What `MapContext.fromBundle` needs from a loaded bundle.
 * @category Context */
export interface BundleInput {
  readonly manifest: { readonly mapName: string; readonly gameBuildId: string }
  readonly entities: ReadonlyArray<RawEntity>
  /** Raycaster + owner semantics. Without it, spatial methods (`height`, `visibleFrom`, `sample`) throw. */
  readonly spatial?: SpatialInput
  /** Accepted user metadata (`metadata.bundle.json`): extra camps/sacrifices/orbs and navmesh overrides, with provenance. Verify its hash before passing it in. */
  readonly metadata?: MetadataInput
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
    readonly settings: MapSettings,
    private readonly report: MetadataReport
  ) {}

  /**
   * Build a context from a loaded bundle (manifest + entities).
   * @example MapContext.fromBundle({ manifest, entities })
   * @category Context
   */
  static fromBundle(bundle: BundleInput, settings: Partial<MapSettings> = {}): MapContext {
    const s: MapSettings = { ...DEFAULT_SETTINGS, ...settings }
    const base = bundle.entities.map((e) => new MapEntity(
      e.id, e.class, e.kind as EntityKind | undefined, new Vec3(...e.position), e.team,
      e.lane === undefined ? undefined : s.laneColors[e.lane], e.lane, e.properties
    ))
    const merged = mergeMetadata(bundle.manifest.mapName, bundle.manifest.gameBuildId, base, bundle.metadata, bundle.spatial, { dedupeRadius: s.metadataDedupeRadius, regionZTolerance: s.regionZTolerance })
    setActiveSpatial(merged.spatial)
    return new MapContext(bundle.manifest.mapName, bundle.manifest.gameBuildId, [...base, ...merged.entities], s, merged.report)
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
  /** What the metadata merge did with each accepted record (applied or skipped, and why, with provenance). @category Context */
  get metadata(): MetadataReport { return this.report }
  /** Navigation queries (paths, travel time). @category Context */
  get nav(): NavApi { return new NavApi() }
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
  /** Sinner's Sacrifice locations (from accepted metadata). @category Context */
  get sinnersSacrifices(): EntityList { return this.ofKind("sinnersSacrifice") }
  /** Ziplines. @category Context */
  get ziplines(): EntityList { return this.ofKind("zipline") }
}
