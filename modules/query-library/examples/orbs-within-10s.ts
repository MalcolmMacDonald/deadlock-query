import { seconds, type MapContext } from "../src/index.ts"

/**
 * Headline query 1: healing orbs within 10 seconds of travel from a yellow-lane guardian.
 * @requires nav
 * @example orbs-within-10s
 * @category Examples
 */
export default (map: MapContext) =>
  map.healingOrbs.withinTravelTime(seconds(10), map.guardians.inLane("yellow")).select((o) => o.id).toArray()
