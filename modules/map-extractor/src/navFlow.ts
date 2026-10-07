import type { Vec3 } from "@deadlock-query/contracts"
import type { NavLink } from "@deadlock-query/spatial-core"
import { parseKv3, type Kv3Value } from "./kv3.ts"
import type { PolygonSoup } from "./navmesh.ts"

/**
 * Reader for `maps/<map>.navflowmap`, the game's coarse pathfinding graph over the `.nav` faces (binary KV3 v5, uncompressed):
 *
 *   { version, hulls: [ { hull_index, nodes: [ { i, center, nav_ids, connections: [ { cost, node_index, nav_id } ], flow_map } ] } ] }
 *
 * `nav_ids` are 1-based face indices of the `.nav` face list (verified on dl_midtown: 102,638 of 103,780 ids lie within 500 units
 * of their node centre). A node is a connected group of faces (53 of 2,549 hull-0 nodes span more than one shared-edge component);
 * a connection says "from this node one can reach node `node_index`, entering at face `nav_id`" at path cost `cost`. Hulls 0..2
 * probably are agent sizes (hero hull classes); which is which has not been verified, hull 0 is used by default.
 * `flow_map` (first entry 15, then ascending ids) is not decoded.
 */

export interface FlowConnection { readonly cost: number; readonly nodeIndex: number; readonly navId: number }
export interface FlowNode { readonly index: number; readonly center: Vec3; readonly navIds: ReadonlyArray<number>; readonly connections: ReadonlyArray<FlowConnection> }
export interface FlowHull { readonly hullIndex: number; readonly nodes: ReadonlyArray<FlowNode> }

const num = (v: Kv3Value | undefined, what: string): number => {
  if (typeof v !== "number") throw new Error(`navflowmap: expected a number for ${what}`)
  return v
}
const list = (v: Kv3Value | undefined): ReadonlyArray<Kv3Value> => (Array.isArray(v) ? v : [])
const obj = (v: Kv3Value | undefined, what: string): { [k: string]: Kv3Value } => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`navflowmap: expected an object for ${what}`)
  return v
}

export const parseFlowMap = (bytes: Uint8Array): FlowHull[] => {
  const root = obj(parseKv3(bytes).value, "root")
  return list(root["hulls"]).map((h, hi) => {
    const hull = obj(h, `hulls[${hi}]`)
    const nodes = list(hull["nodes"]).map((n, ni): FlowNode => {
      const node = obj(n, `hulls[${hi}].nodes[${ni}]`)
      const c = list(node["center"])
      return {
        index: ni,
        center: [num(c[0], "center.x"), num(c[1], "center.y"), num(c[2], "center.z")],
        navIds: list(node["nav_ids"]).map((id) => num(id, "nav_id")),
        connections: list(node["connections"]).map((k) => {
          const conn = obj(k, "connection")
          return { cost: num(conn["cost"], "cost"), nodeIndex: num(conn["node_index"], "node_index"), navId: num(conn["nav_id"], "nav_id") }
        })
      }
    })
    return { hullIndex: num(hull["hull_index"], "hull_index"), nodes }
  })
}

export interface FlowLinkOptions {
  /** Polygon -> shared-edge component (from `polygonComponents`); connections inside one component need no link. */
  readonly component: Int32Array
  readonly faceToPolygon: Int32Array
  readonly soup: PolygonSoup
}

export const NAV_CONNECTION_KIND = "navConnection"

const centroid = (soup: PolygonSoup, poly: number): Vec3 => {
  const p = soup.polys[poly]!, V = soup.vertices
  let x = 0, y = 0, z = 0
  for (const v of p) { x += V[v * 3]!; y += V[v * 3 + 1]!; z += V[v * 3 + 2]! }
  return [x / p.length, y / p.length, z / p.length]
}

/**
 * One-way off-mesh links for the connections that polygon adjacency does not already provide (jumps, drops, climbs, gaps between
 * faces that share no edge): from the face of the source node nearest to the destination face, to the destination face.
 */
export const flowLinks = (hull: FlowHull, o: FlowLinkOptions): { links: NavLink[]; skipped: { sameComponent: number; unresolved: number } } => {
  const links: NavLink[] = []
  const seen = new Set<string>()
  let sameComponent = 0, unresolved = 0
  const polyOf = (navId: number): number => (navId >= 1 && navId <= o.faceToPolygon.length ? o.faceToPolygon[navId - 1]! : -1)
  for (const node of hull.nodes) {
    const srcPolys = [...new Set(node.navIds.map(polyOf).filter((p) => p >= 0))]
    for (const c of node.connections) {
      const dest = polyOf(c.navId)
      if (dest < 0 || srcPolys.length === 0) { unresolved++; continue }
      if (srcPolys.some((p) => o.component[p] === o.component[dest])) { sameComponent++; continue }
      const to = centroid(o.soup, dest)
      let best: Vec3 | undefined, bestD = Infinity
      for (const p of srcPolys) {
        const f = centroid(o.soup, p)
        const d = Math.hypot(f[0] - to[0], f[1] - to[1], f[2] - to[2])
        if (d < bestD) { bestD = d; best = f }
      }
      const key = `${best![0]},${best![1]},${best![2]}>${to[0]},${to[1]},${to[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ from: best!, to, kind: NAV_CONNECTION_KIND, bidirectional: false })
    }
  }
  return { links, skipped: { sameComponent, unresolved } }
}
