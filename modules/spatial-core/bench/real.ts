/** Real-navmesh benchmark. Usage: DL_BUNDLE_DIR=<extracted release> bun bench/real.ts */
import { readFileSync } from "node:fs"
import type { Vec3 } from "@deadlock-query/contracts"
import { NavMesh } from "../src/index.ts"

const dir = process.env.DL_BUNDLE_DIR
if (!dir) throw new Error("set DL_BUNDLE_DIR to the extracted release bundle")
const b = readFileSync(`${dir}/baked/navmesh.bin`)
let t = performance.now()
const lap = (label: string, n = 1) => { const now = performance.now(); console.log(`${label}: ${((now - t) / n).toFixed(2)} ms`); t = now }
const nm = NavMesh.load(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); lap("load")
const model = { speed: 1, linkSpeeds: { jumpPad: 1, navConnection: 1 } }
let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
const pick = (): Vec3 => nm.centroid(Math.floor(rnd() * nm.polyCount))
nm.nearestPoint(pick()); lap("index build + first nearestPoint")
for (let i = 0; i < 1000; i++) nm.nearestPoint(pick()); lap("nearestPoint", 1000)
nm.distanceField([pick()], model); lap("distanceField 1 source")
nm.distanceField(Array.from({ length: 30 }, pick), model); lap("distanceField 30 sources")
for (let i = 0; i < 20; i++) nm.findPath(pick(), pick(), model); lap("findPath (random pair)", 20)
