import type { Entity, EntityKind } from "@deadlock-query/contracts"

/**
 * Lane colours as the game shows them, and the lane numbers entities carry: 1 Yellow, 2 Blue (the middle lane),
 * 3 Green. The game's own data still calls the Green lane "purple" (`boss_rebel_t1_purple`, `combine_t2_boss_purple`,
 * a purple zipline tint), so that word is read as Green and no "purple" lane exists downstream.
 */
export const LANE_NUMBER = { yellow: 1, blue: 2, green: 3 } as const
export type LaneName = keyof typeof LANE_NUMBER

const NAME_TOKEN = /(?:^|[^a-z])(yellow|blue|green|purple)(?![a-z])/i

/** Lane in a name such as `boss_rebel_t1_yellow` or `combine_t2_boss_purple` (the in-game "purple" lane is Green). */
export const laneFromName = (name: string): LaneName | undefined => {
  const m = NAME_TOKEN.exec(name)
  if (!m) return undefined
  const w = m[1]!.toLowerCase()
  return w === "purple" ? "green" : (w as LaneName)
}

/** Kinds whose boss/spawn name ends in the lane colour (patrons, shops, spawns and the like say nothing about a lane). */
const NAMED_LANE_KINDS: ReadonlySet<EntityKind> = new Set(["guardian", "walker", "barracks", "baseSentry"])

/** Name properties tried in order; a guardian only has `bossname`, a walker also repeats it in `targetname`. */
const NAME_KEYS = ["bossname", "subclass_name", "targetname"] as const

export const laneNumberFromProperties = (kind: EntityKind | undefined, props: Readonly<Record<string, unknown>>): number | undefined => {
  if (!kind || !NAMED_LANE_KINDS.has(kind)) return undefined
  for (const k of NAME_KEYS) {
    const v = props[k]
    const lane = typeof v === "string" ? laneFromName(v) : undefined
    if (lane) return LANE_NUMBER[lane]
  }
  return undefined
}

/**
 * Lane of a zipline path from its Hammer `color_tint` (`[r, g, b]`): orange is Yellow, blue is Blue, magenta/purple is
 * Green. Greys and whites (an untinted path) have no lane. Hue ranges are wide on purpose: the tints in the real map are
 * (255,106,0), (0,25,255) and (139,0,139).
 */
export const laneFromTint = (tint: unknown): LaneName | undefined => {
  if (!Array.isArray(tint) || tint.length < 3 || !tint.slice(0, 3).every((c) => typeof c === "number")) return undefined
  const [r, g, b] = (tint as number[]).map((c) => c / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (max === 0 || d / max < 0.25) return undefined
  const h = max === r ? (((g - b) / d) % 6) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
  const hue = (h + 360) % 360
  if (hue >= 15 && hue < 75) return "yellow"
  if (hue >= 180 && hue < 265) return "blue"
  if (hue >= 265 && hue < 340) return "green"
  return undefined
}

/**
 * Zipline nodes take their lane from the path they belong to (`path_uniqueid` = the `citadel_zipline_path`'s
 * `hammeruniqueid`), unless the path is drawn in the base lane colour or untinted.
 */
export const ziplineLanes = (entities: ReadonlyArray<Entity>): Map<string, number> => {
  const byPath = new Map<string, number>()
  for (const e of entities) {
    if (e.class !== "citadel_zipline_path") continue
    const p = e.properties
    const base = p["use_baselane_color"]
    if (base === 1 || base === "1" || base === true) continue
    const lane = laneFromTint(p["color_tint"])
    if (lane) byPath.set(e.id, LANE_NUMBER[lane])
  }
  const out = new Map<string, number>()
  for (const e of entities) {
    if (e.kind !== "zipline") continue
    const path = e.properties["path_uniqueid"]
    const lane = typeof path === "string" || typeof path === "number" ? byPath.get(String(path)) : undefined
    if (lane !== undefined) out.set(e.id, lane)
  }
  return out
}
