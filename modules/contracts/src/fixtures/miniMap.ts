import { Effect, Layer, Stream } from "effect"
import { SCHEMA_VERSION, type Entity, type Manifest } from "../MapBundle.ts"
import { makeResult, type QueryResult } from "../QueryResult.ts"
import { MapDataError, MapDataService, QueryEngine } from "../Services.ts"
import { DEFAULT_GLB_TO_WORLD, distance, type Vec3 } from "../Space.ts"
import { sha256Hex } from "./sha256.ts"
import { writeBoxGlb, type BoxSpec } from "./glb.ts"

/**
 * Synthetic arena, world units (Source units, Z-up). Contains no Valve data.
 *   x in [-4000, 4000] (team 2 base at -x, team 3 base at +x), 3 lanes at y = -2000, 0, 2000.
 *   - window wall at x=0 across lane 2 (glass layer in a solid wall)
 *   - enclosed building (4 walls + roof) around (0, 1000)
 *   - high ledge platform (z=600) at (1500, -1000)
 */
const LANES = [-2000, 0, 2000] as const

const walls: BoxSpec[] = [
  { name: "floor", min: [-4000, -3000, -50], max: [4000, 3000, 0], extras: { SurfaceProperty: "default", InteractAs: ["solid"] } },
  // Wall with window across lane 2 (center), glass in the middle band.
  { name: "wall_low", min: [-20, -300, 0], max: [20, 300, 200], extras: { SurfaceProperty: "concrete", InteractAs: ["solid", "blocklos"] } },
  { name: "wall_high", min: [-20, -300, 400], max: [20, 300, 600], extras: { SurfaceProperty: "concrete", InteractAs: ["solid", "blocklos"] } },
  { name: "window", min: [-5, -300, 200], max: [5, 300, 400], extras: { SurfaceProperty: "glass", InteractAs: ["window"] } },
  // Enclosed building around (0, 1000): 600 x 600 x 400 with a roof, no openings.
  { name: "bldg_n", min: [-300, 1300, 0], max: [300, 1320, 400], extras: { SurfaceProperty: "concrete", InteractAs: ["solid", "blocklos"] } },
  { name: "bldg_s", min: [-300, 680, 0], max: [300, 700, 400], extras: { SurfaceProperty: "concrete", InteractAs: ["solid", "blocklos"] } },
  { name: "bldg_e", min: [300, 700, 0], max: [320, 1300, 400], extras: { SurfaceProperty: "concrete", InteractAs: ["solid", "blocklos"] } },
  { name: "bldg_w", min: [-320, 700, 0], max: [-300, 1300, 400], extras: { SurfaceProperty: "concrete", InteractAs: ["solid", "blocklos"] } },
  { name: "bldg_roof", min: [-320, 680, 400], max: [320, 1320, 420], extras: { SurfaceProperty: "concrete", InteractAs: ["solid", "blocklos"] } },
  // High ledge.
  { name: "ledge", min: [1300, -1200, 560], max: [1700, -800, 600], extras: { SurfaceProperty: "default", InteractAs: ["solid"] } }
]

const ent = (
  id: string, cls: string, kind: Entity["kind"], position: Vec3,
  extra: { team?: number; lane?: number; properties?: Record<string, unknown> } = {}
): Entity => ({
  id, class: cls, ...(kind ? { kind } : {}), position,
  ...(extra.team !== undefined ? { team: extra.team } : {}),
  ...(extra.lane !== undefined ? { lane: extra.lane } : {}),
  properties: extra.properties ?? {}
})

const entities = (): Entity[] => {
  const out: Entity[] = []
  LANES.forEach((y, i) => {
    const lane = i + 1
    for (const [team, x] of [[2, -2500], [3, 2500]] as const) {
      out.push(ent(`guardian-${lane}-${team}`, "info_super_trooper_spawn", "guardian", [x, y, 20], {
        team, lane, properties: { subclass_name: "boss_combine_t1_yellow" }
      }))
    }
  })
  out.push(ent("walker-2-1", "npc_boss_tier2", "walker", [-3000, 0, 20], { team: 2, lane: 2 }))
  out.push(ent("walker-3-1", "npc_boss_tier2", "walker", [3000, 0, 20], { team: 3, lane: 2 }))
  out.push(ent("patron-2", "npc_boss_tier3", "patron", [-3800, 0, 20], { team: 2 }))
  out.push(ent("patron-3", "npc_boss_tier3", "patron", [3800, 0, 20], { team: 3 }))
  out.push(ent("camp-1", "info_neutral_trooper_camp", "creepCamp", [-1000, -1000, 20], { properties: { subclass_name: "neutral_camp_medium" } }))
  out.push(ent("camp-2", "info_neutral_trooper_camp", "creepCamp", [1000, 1000, 20], { properties: { subclass_name: "neutral_camp_strong" } }))
  out.push(ent("camp-3", "info_neutral_trooper_camp", "creepCamp", [0, -2500, 20], { properties: { subclass_name: "neutral_camp_weak" } }))
  const orbs: Vec3[] = [[-800, 400, 20], [800, -400, 20], [1500, -1000, 620], [0, 1000, 20]]
  orbs.forEach((p, i) => out.push(ent(`orb-${i + 1}`, "citadel_pickup_spawner", "healingOrb", p, {
    properties: { subclass_name: "citadel_pickup_floating_health", spawn_delay_override: 180 }
  })))
  // One entity per remaining kind, so consumers can exercise every `EntityKind` (classes as in the real extractor map).
  out.push(ent("sentry-2-1", "npc_base_defense_sentry", "baseSentry", [-3600, 300, 20], { team: 2 }))
  out.push(ent("sentry-3-1", "npc_base_defense_sentry", "baseSentry", [3600, -300, 20], { team: 3 }))
  out.push(ent("barracks-2-1", "npc_barrack_boss", "barracks", [-3400, -2000, 20], { team: 2, lane: 1 }))
  out.push(ent("barracks-3-1", "npc_barrack_boss", "barracks", [3400, 2000, 20], { team: 3, lane: 3 }))
  out.push(ent("zipline-1", "citadel_zipline_path_node", "zipline", [-1500, -1500, 300], { properties: { targetname: "zipline_a_node_0" } }))
  out.push(ent("zipline-2", "citadel_zipline_path_node", "zipline", [-500, -1500, 300], { properties: { targetname: "zipline_a_node_1" } }))
  out.push(ent("jumppad-1", "trigger_catapult", "jumpPad", [1500, -1400, 20]))
  out.push(ent("climbrope-1", "citadel_trigger_climb_rope", "climbRope", [1700, -1000, 300]))
  out.push(ent("interior-1", "citadel_trigger_interior", "interior", [0, 1000, 200]))
  out.push(ent("shop-2-1", "trigger_item_shop", "shop", [-3500, 600, 20], { team: 2 }))
  out.push(ent("shop-3-1", "trigger_item_shop", "shop", [3500, -600, 20], { team: 3 }))
  out.push(ent("spawn-2-1", "info_team_spawn", "spawn", [-3900, 200, 20], { team: 2 }))
  out.push(ent("spawn-3-1", "info_team_spawn", "spawn", [3900, -200, 20], { team: 3 }))
  out.push(ent("trooperspawn-2-2", "info_trooper_spawn", "trooperSpawn", [-3200, 0, 20], { team: 2, lane: 2 }))
  out.push(ent("trooperspawn-3-2", "info_trooper_spawn", "trooperSpawn", [3200, 0, 20], { team: 3, lane: 2 }))
  out.push(ent("capture-1", "citadel_capture_point", "capturePoint", [0, 0, 20]))
  out.push(ent("powerup-1", "citadel_item_powerup_spawner", "powerup", [0, -1500, 20]))
  out.push(ent("crate-1", "item_crate_spawn", "crate", [-1200, 1500, 20]))
  out.push(ent("lanemarker-1", "lane_marker_path", "laneMarker", [0, -2000, 20], { lane: 1 }))
  // An unmapped class is preserved without `kind`.
  out.push(ent("prop-1", "prop_dynamic", undefined, [200, 200, 0], { properties: { model: "models/props/crate.vmdl" } }))
  return out
}

export interface MiniMap {
  readonly manifest: Manifest
  readonly entities: ReadonlyArray<Entity>
  readonly collisionGlb: Uint8Array
  readonly renderGlb: Uint8Array
  /** Expected result of the MVP query: guardians with the distance to the nearest healing orb. */
  readonly expectedGuardianOrbDistance: QueryResult
}

export const buildMiniMap = (): MiniMap => {
  const ents = entities()
  const collisionGlb = writeBoxGlb(walls)
  const renderGlb = writeBoxGlb(walls.map((w) => ({ name: w.name, min: w.min, max: w.max })))
  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    gameBuildId: "0",
    mapName: "mini_map",
    tier: "lite",
    coordinateSystem: { up: "Z", unit: "source", glbToWorld: DEFAULT_GLB_TO_WORLD },
    bounds: { min: [-4000, -3000, -50], max: [4000, 3000, 620] },
    tiles: [{
      id: "t0",
      bounds: { min: [-4000, -3000, -50], max: [4000, 3000, 620] },
      file: "render/t0.glb", bytes: renderGlb.length, sha256: sha256Hex(renderGlb)
    }],
    collision: {
      file: "collision/physics.glb", format: "glb", glbToWorld: DEFAULT_GLB_TO_WORLD,
      layers: ["solid", "blocklos", "window"]
    },
    entitiesFile: "entities.json",
    provenance: { extractorVersion: "fixture", s2vVersion: "none", synthetic: true }
  }
  const orbs = ents.filter((e) => e.kind === "healingOrb")
  const rows = ents.filter((e) => e.kind === "guardian").map((g) => {
    const best = orbs.reduce((a, o) => (distance(g.position, o.position) < distance(g.position, a.position) ? o : a))
    return [g.id, g.position, best.id, Math.round(distance(g.position, best.position) * 1000) / 1000]
  })
  const expectedGuardianOrbDistance = makeResult(
    [
      { name: "guardian", type: "entityRef" }, { name: "position", type: "point" },
      { name: "nearestOrb", type: "entityRef" }, { name: "distance", type: "number" }
    ],
    rows
  )
  return { manifest, entities: ents, collisionGlb, renderGlb, expectedGuardianOrbDistance }
}

/** In-memory MapDataService over the synthetic mini map: lets web modules run standalone. */
export const MockMapDataService = Layer.sync(MapDataService)(() => {
  const m = buildMiniMap()
  const tiles = new Map([["t0", m.renderGlb]])
  return {
    manifest: Effect.succeed(m.manifest),
    entities: Effect.succeed(m.entities),
    loadTile: (id) => {
      const t = tiles.get(id)
      return t ? Effect.succeed(t) : Effect.fail(new MapDataError(`unknown tile ${id}`))
    },
    collisionBytes: Effect.succeed(m.collisionGlb)
  }
})

/** QueryEngine mock: ignores the source and returns the MVP expected result. */
export const MockQueryEngine = Layer.sync(QueryEngine)(() => {
  const result = buildMiniMap().expectedGuardianOrbDistance
  return {
    status: Effect.succeed("idle" as const),
    check: () => Effect.succeed([]),
    run: () => Stream.make({ _tag: "result" as const, result }),
    cancel: Effect.void
  }
})
