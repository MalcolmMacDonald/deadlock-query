import { meters, type MapContext } from "../src/index.ts"

/**
 * Healing orbs within 30 meters of the first yellow guardian, nearest first.
 * @example orbs-near-guardian
 * @category Examples
 */
export default (map: MapContext) => {
  const guardian = map.guardians.inLane("yellow").first()!
  return map.healingOrbs.within(meters(30), guardian).orderBy((o) => o.distanceTo(guardian)).select((o) => o.id).toArray()
}
