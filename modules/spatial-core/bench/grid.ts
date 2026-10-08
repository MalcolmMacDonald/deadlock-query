/** SampleGrid cost report on the real map. Usage: DL_BUNDLE_DIR=<extracted release> bun bench/grid.ts [cellSize...] */
import { readFileSync } from "node:fs"
import type { Aabb } from "@deadlock-query/contracts"
import { Raycaster, SampleGrid } from "../src/index.ts"

const dir = process.env.DL_BUNDLE_DIR
if (!dir) throw new Error("set DL_BUNDLE_DIR to the extracted release bundle")
const ab = (path: string) => { const b = readFileSync(path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as { bounds: Aabb }
let t = performance.now()
const lap = (label: string) => { const now = performance.now(); console.log(`${label}: ${(now - t).toFixed(0)} ms`); t = now }

const rc = Raycaster.deserialize(ab(`${dir}/baked/collision.bvh`)); lap(`Raycaster.deserialize (${rc.triangleCount} triangles)`)
const baked = SampleGrid.deserialize(ab(`${dir}/baked/sample-grid.bin`)); lap("SampleGrid.deserialize (published)")
console.log(`published grid: ${baked.nx} x ${baked.ny} cells of ${baked.cellSize}, channels ${baked.channelNames.join(", ")}, ${(ab(`${dir}/baked/sample-grid.bin`).byteLength / 1e6).toFixed(1)} MB`)

const sizes = process.argv.slice(2).map(Number)
for (const cell of sizes.length ? sizes : [256, 128, 64]) {
  t = performance.now()
  const g = SampleGrid.build(rc, manifest.bounds, cell, {
    // a typical owner channel: one extra ray per cell (headroom above the floor)
    ceiling: (c) => (Number.isNaN(c.floorZ) ? NaN : (rc.raycastFirst([c.x, c.y, c.floorZ + 8], [0, 0, 1])?.distance ?? Infinity)),
  })
  const ms = performance.now() - t
  const cells = g.nx * g.ny
  const floors = (g.raw("floorHeight") as Float32Array).reduce((n: number, z: number) => n + (Number.isNaN(z) ? 0 : 1), 0)
  console.log(`cell ${cell}: ${g.nx} x ${g.ny} = ${cells} cells, ${floors} with floor, build (floor + 1 ray channel) ${ms.toFixed(0)} ms = ${(ms / cells * 1000).toFixed(1)} us/cell, serialised ${(g.serialize().byteLength / 1e6).toFixed(1)} MB`)
}
