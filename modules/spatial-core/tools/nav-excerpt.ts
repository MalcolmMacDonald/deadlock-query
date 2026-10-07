/** Cut a small navmesh excerpt (polygons within `radius` XY of a centre, plus links with both ends inside) from a real navmesh.bin.
 *  Usage: bun tools/nav-excerpt.ts <navmesh.bin> <cx> <cy> <radius> <out.bin> */
import { readFileSync, writeFileSync } from "node:fs"
import { NavMesh, type NavLink } from "../src/index.ts"

const [src, cx, cy, radius, out] = process.argv.slice(2)
if (!out) throw new Error("usage: nav-excerpt <navmesh.bin> <cx> <cy> <radius> <out.bin>")
const b = readFileSync(src!)
const full = NavMesh.load(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
const d = full.data, r = Number(radius), X = Number(cx), Y = Number(cy)
const keep: number[] = []
for (let p = 0; p < full.polyCount; p++) {
  const c = full.centroid(p)
  if (Math.hypot(c[0] - X, c[1] - Y) <= r) keep.push(p)
}
const vmap = new Map<number, number>(), verts: number[] = [], idx: number[] = [], off = [0]
for (const p of keep) {
  for (let i = d.offsets[p]!; i < d.offsets[p + 1]!; i++) {
    const v = d.indices[i]!
    if (!vmap.has(v)) { vmap.set(v, verts.length / 3); verts.push(d.vertices[v * 3]!, d.vertices[v * 3 + 1]!, d.vertices[v * 3 + 2]!) }
    idx.push(vmap.get(v)!)
  }
  off.push(idx.length)
}
const inside = (q: readonly number[]) => Math.hypot(q[0]! - X, q[1]! - Y) <= r
const links: NavLink[] = full.sourceLinks.filter((l) => inside(l.from) && inside(l.to))
const ex = NavMesh.fromPolygons({ vertices: new Float32Array(verts), offsets: new Uint32Array(off), indices: new Uint32Array(idx) }, links)
writeFileSync(out, new Uint8Array(ex.serialize()))
console.log(`${ex.polyCount} polygons, ${links.length} links -> ${out}`)
