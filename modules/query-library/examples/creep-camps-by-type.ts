import type { MapContext } from "../src/index.ts"

/**
 * Number of creep camps per camp type.
 * @example creep-camps-by-type
 * @category Examples
 */
export default (map: MapContext) =>
  map.creepCamps.groupBy((c) => c.properties.subclass_name).select((g) => [g.key, g.items.length]).toArray()
