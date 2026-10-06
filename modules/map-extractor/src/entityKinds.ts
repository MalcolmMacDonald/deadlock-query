import type { EntityKind } from "@deadlock-query/contracts"

/** Class -> normalised kind, from the S2 class survey of dl_midtown (STATE.md). */
const BY_CLASS: Record<string, EntityKind> = {
  npc_boss_tier2: "walker",
  npc_boss_tier3: "patron",
  npc_barrack_boss: "barracks",
  npc_base_defense_sentry: "baseSentry",
  info_neutral_trooper_camp: "creepCamp",
  citadel_zipline_path_node: "zipline",
  trigger_catapult: "jumpPad",
  citadel_trigger_climb_rope: "climbRope",
  citadel_trigger_interior: "interior",
  trigger_item_shop: "shop",
  info_team_spawn: "spawn",
  info_trooper_spawn: "trooperSpawn",
  citadel_capture_point: "capturePoint",
  citadel_item_powerup_spawner: "powerup",
  item_crate_spawn: "crate",
  lane_marker_path: "laneMarker"
}

/** T1 guardians have no class of their own: they are `info_super_trooper_spawn` with a `boss_*_t1_*` subclass. */
const GUARDIAN = /^boss_(rebel|combine)_t1_/

export const entityKind = (cls: string, subclass?: string): EntityKind | undefined => {
  if (cls === "info_super_trooper_spawn") return subclass && GUARDIAN.test(subclass) ? "guardian" : undefined
  if (cls === "citadel_pickup_spawner") return subclass === "citadel_pickup_floating_health" ? "healingOrb" : undefined
  return BY_CLASS[cls]
}
