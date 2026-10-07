import type { Entity, Vec3 } from "@deadlock-query/contracts"
import { laneFromTint, laneName, LANE_NAMES, type LaneName } from "./lanes.ts"

/** One zipline: its nodes in travel order, the lane it belongs to when known, and what the inspector shows for it. */
export interface ZiplinePath {
  readonly id: string
  readonly points: ReadonlyArray<Vec3>
  readonly lane: LaneName | undefined
  /** The `citadel_zipline_path` entity when the bundle has it. */
  readonly path: Entity | undefined
  /** Entity behind the drawn line: the path's own fields plus every node (id, index, position, name). */
  readonly entity: Entity
}

export interface Ziplines {
  readonly paths: ReadonlyArray<ZiplinePath>
  /** Nodes that belong to no path of two or more nodes; nothing to draw a line through, so they stay points. */
  readonly loose: ReadonlyArray<Entity>
}

const idOf = (v: unknown): string | undefined => (typeof v === "string" && v !== "") || typeof v === "number" ? String(v) : undefined

const isOn = (v: unknown): boolean => v === 1 || v === "1" || v === true || v === "true"

/**
 * Zipline nodes share a `path_uniqueid` (the `hammeruniqueid` of their `citadel_zipline_path`) and are ordered by
 * `path_index`. Lane: the extractor's `lane` on the nodes, else the path's `color_tint` (unless it is drawn in the
 * base lane colour).
 */
export const ziplinePaths = (entities: ReadonlyArray<Entity>): Ziplines => {
  const pathEntities = new Map<string, Entity>()
  for (const e of entities) if (e.class === "citadel_zipline_path") pathEntities.set(e.id, e)
  const groups = new Map<string, Entity[]>()
  const loose: Entity[] = []
  for (const e of entities) {
    if (e.kind !== "zipline") continue
    const pid = idOf(e.properties["path_uniqueid"])
    if (pid === undefined) { loose.push(e); continue }
    const g = groups.get(pid)
    if (g) g.push(e)
    else groups.set(pid, [e])
  }
  const paths: ZiplinePath[] = []
  for (const [pid, nodes] of groups) {
    if (nodes.length < 2) { loose.push(...nodes); continue }
    const ordered = nodes
      .map((n, i) => ({ n, i, k: Number(n.properties["path_index"]) }))
      .sort((a, b) => (Number.isFinite(a.k) && Number.isFinite(b.k) ? a.k - b.k : 0) || a.i - b.i)
      .map((x) => x.n)
    const path = pathEntities.get(pid)
    const fromNodes = ordered.map((n) => laneName(n.lane)).find((l) => l !== undefined)
    const lane = fromNodes ?? laneName(path?.lane) ?? (path && !isOn(path.properties["use_baselane_color"]) ? laneFromTint(path.properties["color_tint"]) : undefined)
    const { pathnodes: _spline, ...pathProps } = path?.properties ?? {}
    const entity: Entity = {
      id: path?.id ?? pid,
      class: "citadel_zipline_path",
      kind: "zipline",
      position: ordered[0]!.position,
      ...(lane ? { lane: LANE_NAMES.indexOf(lane) + 1 } : {}),
      properties: {
        ...pathProps,
        nodeCount: ordered.length,
        nodes: ordered.map((n) => ({ id: n.id, index: n.properties["path_index"], position: n.position, ...(n.properties["targetname"] ? { name: n.properties["targetname"] } : {}) }))
      }
    }
    paths.push({ id: pid, points: ordered.map((n) => n.position), lane, path, entity })
  }
  return { paths, loose }
}
