import type { MapContext } from "../src/index.ts"

/**
 * Headline query 2 (shape): healing orb pairs whose walking route is more than 1.5x the straight line.
 * @requires nav
 * @example orb-detours
 * @category Examples
 */
export default (map: MapContext) =>
  map.healingOrbs
    .select((o) => o.position)
    .pairs()
    .where(([a, b]) => a.travelDistanceTo(b) > 1.5 * a.crowFliesTo(b))
    .select(([a, b]) => [a.toArray(), b.toArray()])
    .toArray()
