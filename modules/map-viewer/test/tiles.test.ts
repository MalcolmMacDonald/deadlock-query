import { expect, test } from "bun:test"
import * as THREE from "three"
import {
  buildTileIndex, lodIndexForDistance, parseTileId, planResidency, plannedBytes, selectVisible, tileLod, type ManifestTile
} from "../src/index.ts"

const tile = (id: string, x: number, y: number, bytes = 1000, size = 100): ManifestTile => ({
  id, file: `${id}.glb`, bytes, sha256: "", bounds: { min: [x, y, 0], max: [x + size, y + size, 10] }
})

test("tile ids: base and lod come from the #lod<n> suffix; a lod field wins", () => {
  expect(parseTileId("t_0_1")).toEqual({ base: "t_0_1", lod: 0 })
  expect(parseTileId("t_0_1#lod2")).toEqual({ base: "t_0_1", lod: 2 })
  expect(tileLod(tile("a#lod1", 0, 0))).toBe(1)
  expect(tileLod({ ...tile("a", 0, 0), lod: 3 })).toBe(3)
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
