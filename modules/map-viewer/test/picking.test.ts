import { expect, test } from "bun:test"
import * as THREE from "three"
import { Raycaster } from "@deadlock-query/spatial-core"
import type { Vec3 } from "@deadlock-query/contracts"
import { SurfacePicker, WORLD_TO_THREE, bakedTriangles, worldTriangleSoup } from "../src/index.ts"

/** A 1000 x 1000 floor at z = 100 made of two triangles, plus a 200-high box wall on top of it at x in [400, 500]. */
const terrain = () => {
  const positions = new Float32Array([
    0, 0, 100, 1000, 0, 100, 1000, 1000, 100, 0, 1000, 100,
    400, 0, 300, 500, 0, 300, 500, 1000, 300, 400, 1000, 300
  ])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  return { positions, indices }
}

const down: Vec3 = [0, 0, -1]

test("baked BVH: ray hits report the surface point and the triangle's own vertices", () => {
  const { positions, indices } = terrain()
  const bytes = new Uint8Array(Raycaster.fromGeometry(positions, new Uint32Array(indices)).serialize())
  const picker = SurfacePicker.fromBaked(bytes)
  const hit = picker.raycast([100, 800, 1000], down)!
  expect(picker.source).toBe("baked")
  expect(hit.point[2]).toBeCloseTo(100)
  expect(hit.point[0]).toBeCloseTo(100)
  const tri = hit.triangle!
  // The triangle reported by the lookup must actually contain the hit point (guards the serialized layout).
  const [a, b, c] = tri
  const inPlane = [a, b, c].every((v) => Math.abs(v[2] - 100) < 1e-4)
  expect(inPlane).toBe(true)
  const sign = (p: Vec3, q: Vec3, r: Vec3) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
  const d = [sign(hit.point, a, b), sign(hit.point, b, c), sign(hit.point, c, a)]
  expect(d.every((x) => x >= -1e-3) || d.every((x) => x <= 1e-3)).toBe(true)
  // The wall top is hit first from above.
  expect(picker.raycast([450, 500, 1000], down)!.point[2]).toBeCloseTo(300)
  // A ray that misses everything.
  expect(picker.raycast([5000, 5000, 1000], down)).toBeNull()
})

test("baked BVH: truncated files are rejected", () => {
  const bytes = new Uint8Array(Raycaster.fromGeometry(terrain().positions, terrain().indices).serialize())
  expect(() => SurfacePicker.fromBaked(bytes.subarray(0, 8))).toThrow()
  expect(() => SurfacePicker.fromBaked(bytes.subarray(0, 40))).toThrow()
})

test("baked BVH: a view at an unaligned offset still works", () => {
  const raw = new Uint8Array(Raycaster.fromGeometry(terrain().positions, terrain().indices).serialize())
  const padded = new Uint8Array(raw.length + 3)
  padded.set(raw, 3)
  const hit = SurfacePicker.fromBaked(padded.subarray(3)).raycast([100, 100, 1000], down)!
  expect(hit.point[2]).toBeCloseTo(100)
  expect(hit.triangle).toBeDefined()
})

test("meshes: Three-space geometry is converted to world space before the BVH is built", () => {
  // Floor at world z = 100 is Three y = 100; a group rotated 90 degrees about Y moves it around.
  const geo = new THREE.BufferGeometry()
  const w = terrain()
  // Author the geometry in world coordinates, then put it under a holder that applies WORLD_TO_THREE like the scene does.
  geo.setAttribute("position", new THREE.BufferAttribute(w.positions, 3))
  geo.setIndex(new THREE.BufferAttribute(w.indices, 1))
  const holder = new THREE.Group()
  holder.matrixAutoUpdate = false
  holder.matrix.fromArray([...WORLD_TO_THREE])
  const mesh = new THREE.Mesh(geo)
  holder.add(mesh)
  holder.updateMatrixWorld(true)
  const soup = worldTriangleSoup([mesh])
  expect(soup.indices.length).toBe(12)
  for (let i = 0; i < w.positions.length; i++) expect(soup.positions[i]!).toBeCloseTo(w.positions[i]!)
  const picker = SurfacePicker.fromSoup(soup)!
  expect(picker.source).toBe("meshes")
  const hit = picker.raycast([100, 800, 1000], down)!
  expect(hit.point[2]).toBeCloseTo(100)
  expect(hit.triangle).toHaveLength(3)
})

test("meshes: non-indexed geometry and an empty scene", () => {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, -10]), 3)) // three-space triangle at y = 0
  const mesh = new THREE.Mesh(geo)
  mesh.updateMatrixWorld(true)
  const soup = worldTriangleSoup([mesh])
  expect(Array.from(soup.indices)).toEqual([0, 1, 2])
  expect(SurfacePicker.fromSoup(soup)!.raycast([2, 2, 50], down)).not.toBeNull()
  expect(SurfacePicker.fromSoup(worldTriangleSoup([]))).toBeUndefined()
  expect(bakedTriangles(new Uint8Array(Raycaster.fromGeometry(terrain().positions, terrain().indices).serialize()))(999)).toBeUndefined()
})
