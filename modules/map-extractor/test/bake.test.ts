import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { DEFAULT_GLB_TO_WORLD, buildMiniMap, writeBoxGlb } from "@deadlock-query/contracts"
import { PLACEHOLDER_SEMANTICS, Raycaster, SampleGrid, isInterior, nearestWall } from "@deadlock-query/spatial-core"
import { bakeBundle, loadCollisionMesh, walkableLevels } from "../src/bake.ts"
import { inspectBundle } from "../src/inspect.ts"

/** The contracts mini-map written as a bundle (manifest + collision only), no game data. */
const miniBundle = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-bake-"))
  const m = buildMiniMap()
  mkdirSync(join(dir, "collision"), { recursive: true })
  writeFileSync(join(dir, "collision/physics.glb"), m.collisionGlb)
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m.manifest, tiles: [] }, null, 2))
  writeFileSync(join(dir, "entities.json"), JSON.stringify({ schemaVersion: m.manifest.schemaVersion, entities: m.entities }))
  return dir
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex")
const rd = (p: string) => new Uint8Array(readFileSync(p)).buffer.slice(0) as ArrayBuffer

/** These bake real fixture geometry (0.5 to 1.3 s alone); bun's 5 s default fails them when `verify:all` runs every module at once. */
const BAKE_TIMEOUT_MS = 60_000

test("bake round-trips through spatial-core and matches fixture goldens", async () => {
  const dir = miniBundle()
  const r = await bakeBundle(dir)
  expect(r.errors).toEqual([])
  expect(r.ok).toBe(true)
  const b = r.baked!
  expect(b.placeholder).toBe(PLACEHOLDER_SEMANTICS)
  expect(b.semanticsVersion).toMatch(/^[0-9a-f]{16}$/)
  expect(r.warnings.some((w) => w.includes("placeholder"))).toBe(PLACEHOLDER_SEMANTICS)
  expect(sha(join(dir, b.bvh.file))).toBe(b.bvh.sha256)
  expect(sha(join(dir, b.sampleGrid.file))).toBe(b.sampleGrid.sha256)
  // 10 boxes x 12 triangles
  expect(b.bvh.triangles).toBe(120)

  // BVH: vertical rays land on the known surfaces (world units, Z up).
  const rc = Raycaster.deserialize(rd(join(dir, b.bvh.file)))
  const down = (x: number, y: number) => rc.raycastFirst([x, y, 1000], [0, 0, -1], { backfaces: true })?.point[2]
  expect(down(-2000, 0)).toBeCloseTo(0, 3) // open lane floor
  expect(down(1500, -1000)).toBeCloseTo(600, 3) // ledge top
  expect(down(0, 1000)).toBeCloseTo(420, 3) // building roof
  expect(rc.occluded([-200, 0, 100], [200, 0, 100])).toBe(true) // solid wall_low
  expect(rc.occluded([-200, -1500, 100], [200, -1500, 100])).toBe(false)

  // Sample grid: XY bounds snap outwards to multiples of the 64 cell size.
  const grid = SampleGrid.deserialize(rd(join(dir, b.sampleGrid.file)))
  expect(grid.channelNames.sort()).toEqual(["floorHeight", "interior", "wallDistance"])
  expect([grid.nx, grid.ny, grid.cellSize]).toEqual([126, 94, 64])
  expect(grid.origin).toEqual([-4032, -3008])
  expect(grid.get("floorHeight", [-1968, -24])).toBeCloseTo(0, 3)
  expect(grid.get("floorHeight", [1520, -1000])).toBeCloseTo(600, 3)
  expect(grid.get("floorHeight", [0, 1000])).toBeCloseTo(420, 3) // topmost surface, see STATE.md
  expect(grid.get("floorHeight", [5000, 0])).toBeNull()
  // Cell [-64,0)x[-64,0) has its centre at (-32,-32); the wall face at x=-20 is 12 away.
  expect(grid.get("wallDistance", [-32, -32])).toBeCloseTo(12, 3)
  // Channels equal the semantics functions called directly on the deserialised raycaster.
  const centre = (v: number, o: number) => o + (Math.floor((v - o) / 64) + 0.5) * 64
  for (const p of [[-32, -32], [-1968, -24], [1520, -1000], [0, 1000], [-1000, 1500]] as const) {
    const z = grid.get("floorHeight", p)!
    const c: [number, number, number] = [centre(p[0], -4032), centre(p[1], -3008), z]
    expect(grid.get("interior", p)).toBe(isInterior(rc, c) ? 1 : 0)
    expect(grid.get("wallDistance", p)).toBeCloseTo(nearestWall(rc, c)?.distance ?? 5000, 2)
  }
  expect(grid.get("interior", [-1968, -24])).toBe(0)

  // Manifest: still valid for contracts, records the bake, and inspect accepts it.
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  expect(manifest.baked.inputKey).toBe(b.inputKey)
  expect(manifest.collision.file).toBe("collision/physics.glb")
  const rep = await inspectBundle(dir)
  expect(rep.errors).toEqual([])
  expect(rep.info["baked"]).toEqual({ semanticsVersion: b.semanticsVersion, placeholder: PLACEHOLDER_SEMANTICS })
}, BAKE_TIMEOUT_MS)

test("bake is deterministic and cached until an input changes", async () => {
  const dir = miniBundle()
  const first = await bakeBundle(dir)
  const bvh1 = sha(join(dir, "baked/collision.bvh")), grid1 = sha(join(dir, "baked/sample-grid.bin"))
  const again = await bakeBundle(dir)
  expect(again.cached).toBe(true)
  const forced = await bakeBundle(dir, { force: true })
  expect(forced.cached).toBe(false)
  expect(sha(join(dir, "baked/collision.bvh"))).toBe(bvh1)
  expect(sha(join(dir, "baked/sample-grid.bin"))).toBe(grid1)
  // A different cell size or layer filter invalidates the key.
  const coarse = await bakeBundle(dir, { cellSize: 128 })
  expect(coarse.cached).toBe(false)
  expect(coarse.baked!.inputKey).not.toBe(first.baked!.inputKey)
  expect(coarse.baked!.sampleGrid.nx).toBe(64)
}, BAKE_TIMEOUT_MS)

test("excluded layers are left out of the BVH; the sky default drops sky boxes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-bake-"))
  const m = buildMiniMap()
  const glb = writeBoxGlb([
    { name: "floor", min: [0, 0, -10], max: [1000, 1000, 0], extras: { InteractAs: ["solid"] } },
    { name: "sky", min: [0, 0, 2000], max: [1000, 1000, 2010], extras: { InteractAs: ["sky"] } },
    { name: "skyclip", min: [0, 0, 1500], max: [1000, 1000, 1510], extras: { InteractAs: ["Citadel_Skyclip", "playerclip"] } }
  ])
  mkdirSync(join(dir, "collision"), { recursive: true })
  writeFileSync(join(dir, "collision/physics.glb"), glb)
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m.manifest, tiles: [] }))
  const r = await bakeBundle(dir, { cellSize: 250 })
  expect(r.baked!.bvh.triangles).toBe(12)
  expect(r.baked!.bvh.skippedNodes).toBe(2)
  const grid = SampleGrid.deserialize(rd(join(dir, "baked/sample-grid.bin")))
  expect(grid.get("floorHeight", [500, 500])).toBeCloseTo(0, 3)
  expect(grid.get("interior", [500, 500])).toBe(0) // no sky lid
  // Keeping the sky makes the lid the topmost surface.
  const withSky = await bakeBundle(dir, { cellSize: 250, excludeLayers: [] })
  expect(withSky.baked!.bvh.triangles).toBe(36)
})

test("glbToWorld is applied to node geometry (Y-up GLB -> Z-up world)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-bake-"))
  const p = join(dir, "c.glb")
  writeFileSync(p, writeBoxGlb([{ name: "b", min: [10, 20, 30], max: [11, 22, 33] }]))
  const mesh = await loadCollisionMesh(p, DEFAULT_GLB_TO_WORLD, [])
  const xs = [0, 1, 2].map((a) => [Math.min, Math.max].map((f) => f(...Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.positions[i * 3 + a]!))))
  expect(xs).toEqual([[10, 11], [20, 22], [30, 33]])
})

test("bake errors are reported, not thrown", async () => {
  const empty = mkdtempSync(join(tmpdir(), "dlq-bake-"))
  expect((await bakeBundle(empty)).ok).toBe(false)
  const dir = miniBundle()
  const bad = await bakeBundle(dir, { cellSize: 0 })
  expect(bad.ok).toBe(false)
  expect(bad.errors[0]).toContain("cell-size")
  expect(existsSync(join(dir, "baked"))).toBe(false)
})

test("interior channel comes from the bundle's interior volumes when present", async () => {
  const dir = miniBundle()
  // The lane floor at z 0 near x -2000, y 0: one box around it, one far away.
  writeFileSync(join(dir, "collision/interior-volumes.json"), JSON.stringify({ version: 1, volumes: [
    { id: "a", model: "m", interiorType: 0, origin: [-2000, 0, 0], angles: [0, 0, 0], localMin: [-200, -200, 0], localMax: [200, 200, 300] },
    { id: "b", model: "m", interiorType: 1, origin: [9000, 9000, 0], angles: [0, 0, 0], localMin: [-10, -10, 0], localMax: [10, 10, 10] }
  ] }))
  const r = await bakeBundle(dir, { cellSize: 100 })
  expect(r.errors).toEqual([])
  expect((r.baked as unknown as { interiorSource: string }).interiorSource).toBe("volumes")
  const grid = SampleGrid.deserialize(rd(join(dir, r.baked!.sampleGrid.file)))
  expect(grid.get("interior", [-2000, 0])).toBe(1)
  expect(grid.get("interior", [-1500, 0])).toBe(0)
}, BAKE_TIMEOUT_MS)

test("walkableLevels lists stacked floors top first and merges surfaces within the gap", async () => {
  const { Raycaster } = await import("@deadlock-query/spatial-core")
  const quad = (z: number) => [-10, -10, z, 10, -10, z, 10, 10, z, -10, 10, z]
  const positions = new Float32Array([...quad(0), ...quad(30), ...quad(400), ...quad(405)])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15])
  const rc = Raycaster.fromGeometry(positions, indices)
  expect(walkableLevels(rc, 0, 0, 1000, 48)).toEqual([405, 30])
  expect(walkableLevels(rc, 0, 0, 1000, 10)).toEqual([405, 30, 0])
  expect(walkableLevels(rc, 500, 500, 1000, 48)).toEqual([])
})
