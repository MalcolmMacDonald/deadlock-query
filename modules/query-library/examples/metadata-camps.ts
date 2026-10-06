import type { MapContext } from "../src/index.ts"

/**
 * Creep camps that came from accepted user metadata, with who submitted and who reviewed them.
 * @requires metadata
 * @example metadata-camps
 * @category Examples
 */
export default (map: MapContext) =>
  map.creepCamps
    .fromSource("metadata")
    .select((c) => ({ id: c.id, submitter: c.provenance?.submitter?.name, reviewer: c.provenance?.reviewer, position: c.position.toArray() }))
    .toArray()
