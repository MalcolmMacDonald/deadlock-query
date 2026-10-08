import { expect, test } from "bun:test"
import * as THREE from "three"
import {
  TileStreamer, buildTileIndex, decodeTileGlb, decodedBytes, glbToThreeMatrix, inlineDecoder, workerDecoder,
  type DecodedTile, type TileDecoder, type WorkerLike, type WorkerReply, type WorkerRequest
} from "../src/index.ts"
import { DEFAULT_SYNTHETIC, heightfieldGlb, syntheticMap } from "../e2e/synthetic.ts"

const MB = 1024 * 1024

const cameraAt = (x: number, altitude: number, y: number, tilt = 0) => {
  // world (x, y) -> Three (x, z, -y); look straight down (tilt moves the target along -Z for a slanted view)
  const c = new THREE.PerspectiveCamera(50, 1.6, 5, 200_000)
  c.position.set(x, altitude, -y)
  c.lookAt(x, 0, -y - tilt)
  c.updateMatrixWorld()
  return c
}

/** Decoder that fabricates geometry of `inflation` x the file size, so no real GLBs are needed. */
const fakeDecoder = (inflation = 1): TileDecoder & { decoded: number } => {
  const d = {
    decoded: 0,
    decode: async (bytes: Uint8Array): Promise<DecodedTile> => {
      d.decoded++
      return { positions: new Float32Array(Math.floor((bytes.byteLength * inflation) / 12) * 3), indices: new Uint32Array(0) }
    },
    dispose: () => {}
  }
  return d
}

test("synthetic map is over 500 MB of tile files", () => {
  const map = syntheticMap()
  expect(map.totalTileBytes).toBeGreaterThan(500 * MB)
  expect(map.manifest.tiles).toHaveLength(DEFAULT_SYNTHETIC.cols * DEFAULT_SYNTHETIC.rows * DEFAULT_SYNTHETIC.grids.length)
})

/** The flight decodes about 0.6 GB of fabricated geometry and bounds every tile (about 1.4 s alone). `bun test` allows 5 s, which a loaded `verify:all` (every module in parallel) exceeds. */
const STREAM_FLIGHT_TIMEOUT_MS = 60_000

test("streaming a >500 MB map through a flight stays within the memory budget", async () => {
  const map = syntheticMap()
  const budget = 128 * MB
  const decoder = fakeDecoder(2) // meshopt-style inflation: decoded geometry is twice the file
  const fetched = new Set<string>()
  const streamer = new TileStreamer({
    cells: buildTileIndex(map.manifest.tiles),
    fetchTile: async (t) => { fetched.add(t.id); return new Uint8Array(t.bytes) },
    decoder, glbToThree: glbToThreeMatrix(map.manifest.coordinateSystem.glbToWorld),
    material: new THREE.MeshBasicMaterial(), budgetBytes: budget
  })
  const half = (DEFAULT_SYNTHETIC.cols * DEFAULT_SYNTHETIC.cell) / 2
  // Fly low across the whole map in a lawnmower pattern, then pull back for the overview.
  const path: Array<[number, number, number]> = []
  for (let row = 0; row < 4; row++) {
    const y = -half + 1500 + row * 3500
    for (let k = 0; k <= 6; k++) path.push([row % 2 ? half - 1000 - k * 2200 : -half + 1000 + k * 2200, y, 1800])
  }
  path.push([0, 0, 22_000], [0, 0, 60_000])
  let seenLod0 = 0
  for (const [x, y, alt] of path) {
    streamer.update(cameraAt(x, alt, y))
    await streamer.idle()
    const s = streamer.stats()
    expect(s.residentBytes).toBeLessThanOrEqual(budget)
    expect(s.peakBytes).toBeLessThanOrEqual(budget)
    expect(s.failed).toBe(0)
    expect(s.visibleCells).toBeGreaterThan(0)
    expect(s.displayed).toBe(s.visibleCells) // no holes: every visible cell shows some LOD
    if (alt < 3000 && [...streamer.root.children].some((m) => m.visible && (m as THREE.Mesh).geometry.getAttribute("position").array.byteLength >= 2 * 2.3 * MB)) seenLod0++
  }
  const s = streamer.stats()
  expect(seenLod0).toBeGreaterThan(10) // close views really show the finest LOD
  expect(s.evicted).toBeGreaterThan(0)
  // Far more was streamed than ever fit: the budget, not the map size, bounds memory.
  expect(decoder.decoded * 1).toBeGreaterThan(100)
  const decodedTotal = [...fetched].reduce((n, id) => n + map.manifest.tiles.find((t) => t.id === id)!.bytes * 2, 0)
  expect(decodedTotal).toBeGreaterThan(2 * budget)
  streamer.dispose()
  expect(streamer.stats().residentBytes).toBe(0)
}, STREAM_FLIGHT_TIMEOUT_MS)

test("a view that needs more than the budget drops the farthest cells instead of exceeding it", async () => {
  const map = syntheticMap({ cols: 6, rows: 6, grids: [260, 130] })
  const budget = 20 * MB // coarse LODs alone: 36 x 0.6 MB x 2 = 43 MB
  const streamer = new TileStreamer({
    cells: buildTileIndex(map.manifest.tiles),
    fetchTile: async (t) => new Uint8Array(t.bytes), decoder: fakeDecoder(2),
    glbToThree: new THREE.Matrix4(), material: new THREE.MeshBasicMaterial(), budgetBytes: budget
  })
  streamer.update(cameraAt(0, 30_000, 0))
  await streamer.idle()
  const s = streamer.stats()
  expect(s.residentBytes).toBeLessThanOrEqual(budget)
  expect(s.visibleCells).toBe(36)
  expect(s.displayed).toBeGreaterThan(0)
  expect(s.displayed).toBeLessThan(36)
  streamer.dispose()
})

test("a finer LOD replaces the coarse one as the camera approaches, and the coarse one becomes evictable", async () => {
  const map = syntheticMap({ cols: 2, rows: 2, grids: [130, 65] })
  const streamer = new TileStreamer({
    cells: buildTileIndex(map.manifest.tiles),
    fetchTile: async (t) => new Uint8Array(t.bytes), decoder: fakeDecoder(1),
    glbToThree: new THREE.Matrix4(), material: new THREE.MeshBasicMaterial(), budgetBytes: 64 * MB
  })
  streamer.update(cameraAt(0, 40_000, 0))
  await streamer.idle()
  const far = streamer.stats()
  const coarseBytes = far.residentBytes
  expect(far.displayed).toBe(4)
  streamer.update(cameraAt(0, 300, 0))
  await streamer.idle()
  const near = streamer.stats()
  expect(near.residentBytes).toBeGreaterThan(coarseBytes)
  const shown = streamer.root.children.filter((c) => c.visible) as THREE.Mesh[]
  expect(Math.max(...shown.map((m) => m.geometry.getAttribute("position").array.byteLength))).toBeGreaterThan(coarseBytes / 4 * 2)
  streamer.dispose()
})

test("a tile that fails to load is reported and does not stall the rest", async () => {
  const map = syntheticMap({ cols: 2, rows: 1, grids: [65] })
  const bad = map.manifest.tiles[0]!.id
  const warn = console.warn
  console.warn = () => {}
  const streamer = new TileStreamer({
    cells: buildTileIndex(map.manifest.tiles),
    fetchTile: async (t) => { if (t.id === bad) throw new Error("HTTP 500"); return new Uint8Array(t.bytes) }, decoder: fakeDecoder(1),
    glbToThree: new THREE.Matrix4(), material: new THREE.MeshBasicMaterial(), budgetBytes: 64 * MB
  })
  streamer.update(cameraAt(0, 4000, 0))
  await streamer.idle()
  console.warn = warn
  const s = streamer.stats()
  expect(s.failed).toBe(1)
  expect(s.displayed).toBe(1)
  streamer.dispose()
})

test("real GLB decode: merges the mesh into one indexed geometry in GLB space", async () => {
  const map = syntheticMap({ cols: 1, rows: 1, grids: [9] })
  const d = await decodeTileGlb(map.glb("c0_0"))
  expect(d.positions.length).toBe(9 * 9 * 3)
  expect(d.indices.length).toBe(8 * 8 * 6)
  expect(d.indices).toBeInstanceOf(Uint16Array)
  const xs = Array.from({ length: 81 }, (_, i) => d.positions[i * 3]!)
  expect(Math.min(...xs)).toBeCloseTo(-500, 1)
  expect(Math.max(...xs)).toBeCloseTo(500, 1)
  expect(await inlineDecoder().decode(map.glb("c0_0"))).toBeDefined()
})

/** A worker that "decodes" by running the same decode on a microtask, to exercise the pool and its fallback. */
const fakeWorker = (mode: "ok" | "die"): WorkerLike => {
  const w: WorkerLike = {
    onmessage: null, onerror: null, terminate: () => {},
    postMessage: (msg: WorkerRequest) => {
      queueMicrotask(async () => {
        if (mode === "die") { w.onerror?.(new Error("worker failed to load")); return }
        const d = await decodeTileGlb(msg.bytes)
        const reply: WorkerReply = { id: msg.id, ok: true, positions: d.positions, indices: d.indices, colors: d.colors }
        w.onmessage?.({ data: reply })
      })
    }
  }
  return w
}

test("worker pool decodes through workers, and falls back to the calling thread when they die or cannot start", async () => {
  const glb = syntheticMap({ cols: 1, rows: 1, grids: [9] }).glb("c0_0")
  const ok = workerDecoder(() => fakeWorker("ok"), 2)
  expect((await Promise.all([ok.decode(glb), ok.decode(glb), ok.decode(glb)])).every((d) => d.positions.length === 243)).toBe(true)
  const dying = workerDecoder(() => fakeWorker("die"), 2)
  expect((await dying.decode(glb)).positions.length).toBe(243)
  expect((await dying.decode(glb)).positions.length).toBe(243) // stays on the fallback
  const unavailable = workerDecoder(() => { throw new Error("no workers here") }, 2)
  expect((await unavailable.decode(glb)).positions.length).toBe(243)
})

test("vertex colours: decoded as RGBA8 per vertex, counted in the budget, carried by the worker pool, drawn with the colour material", async () => {
  const plain = await decodeTileGlb(heightfieldGlb(0, 0, 100, 9))
  expect(plain.colors).toBeUndefined()
  const glb = heightfieldGlb(0, 0, 100, 9, true)
  const d = await decodeTileGlb(glb)
  expect(d.colors).toBeInstanceOf(Uint8Array)
  expect(d.colors!.length).toBe(9 * 9 * 4)
  expect([...d.colors!.subarray(0, 4)].every((v) => v >= 0 && v <= 255)).toBe(true)
  expect(d.colors![3]).toBe(255)
  // the colour follows the vertex: red grows with height (glTF Y), blue falls
  const hi = [...Array(81).keys()].reduce((a, b) => (d.positions[b * 3 + 1]! > d.positions[a * 3 + 1]! ? b : a))
  const lo = [...Array(81).keys()].reduce((a, b) => (d.positions[b * 3 + 1]! < d.positions[a * 3 + 1]! ? b : a))
  expect(d.colors![hi * 4]).toBeGreaterThan(d.colors![lo * 4]!)
  expect(d.colors![hi * 4 + 2]).toBeLessThan(d.colors![lo * 4 + 2]!)
  expect(decodedBytes(d)).toBe(plain.positions.byteLength + d.indices.byteLength + 81 * 4)

  const pool = workerDecoder(() => fakeWorker("ok"), 1)
  expect((await pool.decode(glb)).colors).toEqual(d.colors)

  const colorMat = new THREE.MeshBasicMaterial({ vertexColors: true }), plainMat = new THREE.MeshBasicMaterial()
  const mk = (glbBytes: Uint8Array) => {
    const map = syntheticMap({ cols: 1, rows: 1, grids: [9] })
    const s = new TileStreamer({
      cells: buildTileIndex(map.manifest.tiles), fetchTile: async () => glbBytes, decoder: inlineDecoder(),
      glbToThree: glbToThreeMatrix(map.manifest.coordinateSystem.glbToWorld), material: plainMat, colorMaterial: colorMat, budgetBytes: 64 * MB
    })
    s.update(cameraAt(0, 1500, 0))
    return s
  }
  for (const [bytes, material, hasColor] of [[glb, colorMat, true], [heightfieldGlb(0, 0, 100, 9), plainMat, false]] as const) {
    const s = mk(bytes)
    await s.idle()
    const mesh = s.root.children[0] as THREE.Mesh
    expect(mesh.material).toBe(material)
    expect(mesh.geometry.getAttribute("color") !== undefined).toBe(hasColor)
    if (hasColor) { expect(mesh.geometry.getAttribute("color").normalized).toBe(true); expect(mesh.geometry.getAttribute("color").itemSize).toBe(4) }
    s.dispose()
  }
})

test("fetches for tiles the camera moved away from are aborted, not counted as failures", async () => {
  const map = syntheticMap({ cols: 4, rows: 1, grids: [65] })
  const aborted: string[] = []
  const streamer = new TileStreamer({
    cells: buildTileIndex(map.manifest.tiles),
    fetchTile: (t, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => { aborted.push(t.id); reject(new Error("aborted")) })
      setTimeout(() => resolve(new Uint8Array(t.bytes)), 50)
    }),
    decoder: fakeDecoder(1), glbToThree: new THREE.Matrix4(), material: new THREE.MeshBasicMaterial(), budgetBytes: 64 * MB, maxInFlight: 8
  })
  streamer.update(cameraAt(0, 400, 0))
  streamer.update(cameraAt(1e7, 400, 0)) // far away: nothing near is wanted any more
  await new Promise((r) => setTimeout(r, 120))
  expect(aborted.length).toBeGreaterThan(0)
  expect(streamer.stats().failed).toBe(0)
  streamer.dispose()
})
