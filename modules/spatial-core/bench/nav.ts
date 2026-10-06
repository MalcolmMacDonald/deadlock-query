/** Dijkstra + nearestPoint benchmark on a synthetic navmesh (PLAN M4/M5 gate: 30 sources over ~50k polygons). */
import { NavMesh, type NavMeshData } from "../src/index.ts"

/** `n`x`n` grid of quads (cell 100 units) over rolling terrain, with scattered blocked-out cells. */
const gridMesh = (n: number): NavMeshData => {
  const vertices = new Float32Array((n + 1) * (n + 1) * 3)
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.set([i * 100, j * 100, Math.sin(i / 9) * 150 + Math.cos(j / 7) * 150], (j * (n + 1) + i) * 3)
  const indices: number[] = [], offsets = [0]
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if ((i * 7919 + j * 104729) % 13 === 0) continue
    const a = j * (n + 1) + i
    indices.push(a, a + 1, a + n + 2, a + n + 1); offsets.push(indices.length)
  }
  return { vertices, offsets: new Uint32Array(offsets), indices: new Uint32Array(indices) }
}

const ms = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t }
const n = 240
const data = gridMesh(n)
let nm!: NavMesh
const polys = data.offsets.length - 1
console.log(`mesh: ${polys} polygons, ${data.vertices.length / 3} vertices`)
console.log(`build + index (first nearestPoint): ${ms(() => { nm = NavMesh.fromPolygons(data); nm.nearestPoint([0, 0, 0]) }).toFixed(0)} ms`)

let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const pt = (): [number, number, number] => [rnd() * n * 100, rnd() * n * 100, 0]

const q = Array.from({ length: 2000 }, pt)
console.log(`nearestPoint x${q.length}: ${ms(() => { for (const p of q) nm.nearestPoint(p) }).toFixed(1)} ms`)

const sources = Array.from({ length: 30 }, pt)
let field!: ReturnType<NavMesh["distanceField"]>
const model = { speed: 7 * 39.37 }
console.log(`distanceField (30 sources, ${polys} polys): ${ms(() => { field = nm.distanceField(sources, model) }).toFixed(0)} ms`)
const reach = field.costs.reduce((c, x) => c + (Number.isFinite(x) ? 1 : 0), 0)
console.log(`reachable polygons: ${reach} / ${polys}`)
console.log(`costAt x${q.length}: ${ms(() => { for (const p of q) field.costAt(p) }).toFixed(1)} ms`)
console.log(`findPath x50: ${ms(() => { for (let i = 0; i < 50; i++) nm.findPath(pt(), pt(), model) }).toFixed(0)} ms`)
