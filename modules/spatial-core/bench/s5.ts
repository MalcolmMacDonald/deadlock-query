import { isMainThread } from "bun"
import { Sphere, Vector3, Ray } from "three"
import { MeshBVH } from "three-mesh-bvh"
import { makeScene } from "./scene.ts"

declare var self: Worker

function run(where: string) {
  const TRIS = Number((globalThis as any).process?.env?.TRIS ?? 1_000_000)
  const RAYS = 100_000
  const ms = (f: () => void) => { const t = performance.now(); f(); return +(performance.now() - t).toFixed(1) }

  const geo = makeScene(TRIS)
  const n = geo.index!.count / 3
  const out: Record<string, unknown> = { runtime: where, triangles: n }
  let bvh!: MeshBVH
  out.buildMs = ms(() => { bvh = new MeshBVH(geo, { strategy: 0, maxLeafTris: 10 }) })

  const bounds = { x: Math.sqrt(n / 2) * 10 }
  let seed = 7
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const rays = Array.from({ length: RAYS }, () =>
    new Ray(new Vector3(rnd() * bounds.x, rnd() * bounds.x, 1000), new Vector3(0, 0, -1)))
  let hits = 0
  out.rays100kMs = ms(() => { for (const r of rays) if (bvh.raycastFirst(r)) hits++ })
  out.rayHits = hits

  const sphere = new Sphere(new Vector3(bounds.x / 2, bounds.x / 2, 0), 30)
  out.capsuleLikeShapecastMs = ms(() => {
    for (let i = 0; i < 1000; i++) {
      sphere.center.x = rnd() * bounds.x; sphere.center.y = rnd() * bounds.x
      bvh.intersectsSphere(sphere)
    }
  }) + " (1000 sphere tests)"

  const sBVH = MeshBVH.serialize(bvh, { cloneBuffers: false })
  const bytes = sBVH.roots.reduce((a: number, r: ArrayBuffer) => a + r.byteLength, 0)
  out.serializedMB = +(bytes / 1e6).toFixed(1)
  let again = 0
  out.deserializeMs = ms(() => { MeshBVH.deserialize(sBVH, geo) ; again++ })
  return out

}

if (!isMainThread) {
  self.postMessage(run(`bun ${Bun.version} worker`))
} else {
  console.log(JSON.stringify(run(`bun ${Bun.version} main`), null, 2))
  const w = new Worker(import.meta.url)
  w.onmessage = (e) => { console.log(JSON.stringify(e.data, null, 2)); w.terminate() }
}
