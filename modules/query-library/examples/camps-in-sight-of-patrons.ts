import type { MapContext } from "../src/index.ts"

/**
 * Creep camps with a clear straight line (collision geometry only, no owner semantics) to a patron.
 * @requires nav
 * @example camps-in-sight-of-patrons
 * @category Examples
 */
export default (map: MapContext) => map.creepCamps.withLineOfSightTo(map.patrons).select((c) => c.id).toArray()
