import type { MapContext } from "../src/index.ts"

/**
 * Headline query 3: neutral camps visible from high ground (floor 800+ units above the map's
 * lowest point). Results are provisional while `map.provisional` is true.
 * @requires spatial
 * @example camps-visible-from-high-ground
 * @category Examples
 */
export default (map: MapContext) =>
  map.creepCamps
    .visibleFrom(map.sample.grid(400).where((p) => p.height() >= 800))
    .select((c) => c.id)
    .toArray()
