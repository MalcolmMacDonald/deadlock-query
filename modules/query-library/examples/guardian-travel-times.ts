import type { MapContext } from "../src/index.ts"

/**
 * Walking time in seconds from the first patron to each guardian, with its lane, nearest first.
 * @requires nav
 * @example guardian-travel-times
 * @category Examples
 */
export default (map: MapContext) => {
  const from = map.nav.timeFrom(map.patrons.first()!.position)
  return map.guardians
    .select((g) => ({ id: g.id, lane: g.lane ?? null, seconds: Math.round(from(g.position) * 10) / 10 }))
    .orderBy((r) => r.seconds)
    .toArray()
}
