import type { MapContext } from "../src/index.ts"

/**
 * Ids of the yellow-lane guardians, optionally narrowed to one team.
 * @example yellow-lane-guardians
 * @category Examples
 */
export default (map: MapContext) => map.guardians.inLane("yellow").onTeam(2).select((g) => g.id).toArray()
