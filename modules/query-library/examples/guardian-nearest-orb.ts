import type { MapContext } from "../src/index.ts"

/**
 * Distance from every guardian to its nearest healing orb.
 * @example guardian-nearest-orb
 * @category Examples
 */
export default (map: MapContext) =>
  map.guardians
    .select((g) => {
      const orb = map.healingOrbs.closest(g)!
      return [g.id, g.position.toArray(), orb.id, Math.round(g.distanceTo(orb) * 1000) / 1000]
    })
    .toArray()
