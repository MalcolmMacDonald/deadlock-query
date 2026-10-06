import { meters, type MapContext } from "../src/index.ts"

/**
 * Creep camps per 100 m square, busiest first.
 * @example camp-density
 * @category Examples
 */
export default (map: MapContext) =>
  map.sample
    .density(map.creepCamps, meters(100))
    .orderByDescending((c) => c.count)
    .select((c) => [c.region.key, c.count])
    .toArray()
