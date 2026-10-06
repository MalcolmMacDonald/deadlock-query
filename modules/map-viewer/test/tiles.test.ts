import { expect, test } from "bun:test"
import * as THREE from "three"
import {
  buildTileIndex, lodIndexForDistance, planResidency, plannedBytes, selectVisible, type ManifestTile
} from "../src/index.ts"
import { tileBaseId, tileLod } from "@deadlock-query/contracts"

const tile = (id: string, x: number, y: number, bytes = 1000, size = 100): ManifestTile => ({
  id, file: `${id}.glb`, bytes, sha256: "", bounds: { min: [x, y, 0], max: [x + size, y + size, 10] }
})

test("tile LOD comes from the lod field, else the legacy #lod<n> id suffix", () => {
  expect(tileLod(tile("t_0_1", 0, 0))).toBe(0)
  expect(tileLod(tile("t_0_1#lod2", 0, 0))).toBe(2)
  expect(tileBaseId(tile("t_0_1#lod2", 0, 0))).toBe("t_0_1")
  expect(tileLod({ ...tile("a", 0, 0), lod: 3 })).toBe(3)
  expect(tileBaseId({ ...tile("tiles/a.lod1", 0, 0), lodOf: "a" })).toBe("a")
})

test("the index groups LODs given by lod / lodOf fields, with ids that carry no suffix", () => {
  const cells = buildTileIndex([
    { ...tile("a.far", 0, 0), lod: 1, lodOf: "a" }, tile("a", 0, 0), { ...tile("a.farther", 0, 0), lod: 2, lodOf: "a" }, tile("b", 100, 0)
  ])
  expect(cells.map((c) => [c.base, c.lods.map((l) => l.tile.id)])).toEqual([["a", ["a", "a.far", "a.farther"]], ["b", ["b"]]])
})

test("the index groups LODs by base id, finest first, with a Three-space box", () => {
  const cells = buildTileIndex([tile("a#lod1", 0, 0), tile("b", 100, 0), tile("a", 0, 0)])
  expect(cells.map((c) => c.base)).toEqual(["a", "b"])
  expect(cells[0]!.lods.map((l) => l.lod)).toEqual([0, 1])
  // world (x, y, z) -> Three (x, z, -y)
  expect(cells[1]!.box.min.toArray()).toEqual([100, 0, -100])
  expect(cells[1]!.box.max.x).toBe(200)
  expect(cells[1]!.box.max.y).toBe(10)
  expect(cells[1]!.box.max.z).toBeCloseTo(0)
})

test("lod index grows by one per doubling of distance and is clamped", () => {
  expect(lodIndexForDistance(0, 100, 3)).toBe(0)
  expect(lodIndexForDistance(150, 100, 3)).toBe(0) // inside 1.5 diagonals
  expect(lodIndexForDistance(200, 100, 3)).toBe(1)
  expect(lodIndexForDistance(310, 100, 3)).toBe(2)
  expect(lodIndexForDistance(1e6, 100, 3)).toBe(2)
  expect(lodIndexForDistance(1e6, 100, 1)).toBe(0)
})

const camera = (eye: [number, number, number], at: [number, number, number], far = 100_000) => {
  const c = new THREE.PerspectiveCamera(50, 1.6, 5, far)
  c.position.set(...eye)
  c.lookAt(...at)
  c.updateMatrixWorld()
  return c
}

test("selection culls to the frustum and sorts nearest first", () => {
  // 10 x 10 cells of 100 units, camera above the middle looking straight down.
  const tiles: ManifestTile[] = []
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) tiles.push(tile(`c${i}_${j}`, i * 100, j * 100))
  const cells = buildTileIndex(tiles)
  const all = selectVisible(cells, camera([500, 3000, -500], [500, 0, -500]))
  expect(all).toHaveLength(100)
  const near = selectVisible(cells, camera([50, 120, -50], [50, 0, -50]))
  expect(near.length).toBeGreaterThan(0)
  expect(near.length).toBeLessThan(10)
  expect(near[0]!.cell.base).toBe("c0_0")
  for (let i = 1; i < near.length; i++) expect(near[i]!.distance).toBeGreaterThanOrEqual(near[i - 1]!.distance)
  expect(selectVisible(cells, camera([50, 120, -50], [50, 120, 500]))).toHaveLength(0) // looking away
})

test("residency plan: coarsest first, upgrades nearest first, never above budget", () => {
  const mk = (id: string, x: number) => [tile(id, x, 0, 100), tile(`${id}#lod1`, x, 0, 25)]
  const cells = buildTileIndex([...mk("a", 0), ...mk("b", 100), ...mk("c", 200)])
  const cost = (t: ManifestTile) => t.bytes
  const visible = cells.map((cell, i) => ({ cell, distance: i * 100, want: 0 }))
  // Room for everything fine: all at LOD0.
  expect(planResidency(visible, 1000, cost).map((p) => p.index)).toEqual([0, 0, 0])
  // 25+25+25 coarse = 75; upgrades cost 75 each: 150 fits one upgrade (the nearest), the rest stay coarse.
  const tight = planResidency(visible, 150, cost)
  expect(tight.map((p) => p.index)).toEqual([0, 1, 1])
  expect(plannedBytes(tight, cost)).toBeLessThanOrEqual(150)
  // Not even the coarse LODs fit: the farthest cells are dropped.
  const tiny = planResidency(visible, 60, cost)
  expect(tiny.map((p) => p.cell.base)).toEqual(["a", "b"])
  // A cell whose distance only asks for LOD1 is never upgraded past it.
  expect(planResidency(visible.map((v) => ({ ...v, want: 1 })), 1000, cost).map((p) => p.index)).toEqual([1, 1, 1])
})

test("the eager path loads and draws only the LOD0 tiles", async () => {
  const { Effect, Layer } = await import("effect")
  const { MapDataService, MockMapDataService } = await import("@deadlock-query/contracts")
  const { loadViewerData, buildScene } = await import("../src/index.ts")
  const { syntheticMap } = await import("../e2e/synthetic.ts")
  const map = syntheticMap({ cols: 2, rows: 1, grids: [9, 5] }) // ids c0_0, c0_0#lod1, c1_0, c1_0#lod1
  const asked: string[] = []
  const base = await Effect.runPromise(MockMapDataService.pipe(Layer.build, Effect.scoped, Effect.map((c) => Effect.runSync(Effect.service(MapDataService).pipe(Effect.provide(Layer.succeedContext(c)))))))
  const layer = Layer.succeed(MapDataService)({
    ...base, manifest: Effect.succeed(map.manifest), entities: Effect.succeed([]),
    loadTile: (id: string) => { asked.push(id); return Effect.succeed(map.glb(id)) }
  })
  const data = await Effect.runPromise(loadViewerData.pipe(Effect.provide(layer)))
  expect(asked).toEqual(["c0_0", "c1_0"])
  expect([...data.tiles.keys()]).toEqual(["c0_0", "c1_0"])
  const all = new Map(map.manifest.tiles.map((t) => [t.id, map.glb(t.id)]))
  const scene = await buildScene({ ...data, tiles: all })
  const holders = scene.children.filter((c) => (c as { matrixAutoUpdate: boolean }).matrixAutoUpdate === false)
  expect(holders).toHaveLength(2) // one per LOD0 tile, even though the LOD tiles' bytes were offered
})
