import { meters, type MapContext } from "../src/index.ts"

/**
 * Chokepoints: the 50 m squares crossed by the most guardian-to-guardian walking routes (waypoints counted per route once per square).
 * @requires nav
 * @example path-chokepoints
 * @category Examples
 */
export default (map: MapContext) => {
  const cell = meters(50)
  const counts = new Map<string, number>()
  for (const [a, b] of map.guardians.select((g) => g.position).pairs().toArray()) {
    const route = map.nav.path(a, b)
    if (!route) continue
    for (const key of new Set(map.sample.density(route.points, cell).select((c) => c.region.key).toArray())) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 5)
}
