import type { MapContext } from "../src/index.ts"

/**
 * Creep camps a walker cannot reach from the first patron (off the mesh or on a disconnected piece).
 * @requires nav
 * @example unreachable-camps
 * @category Examples
 */
export default (map: MapContext) => {
  const from = map.nav.timeFrom(map.patrons.first()!.position)
  return map.creepCamps.where((c) => !Number.isFinite(from(c.position))).select((c) => c.id).toArray()
}
