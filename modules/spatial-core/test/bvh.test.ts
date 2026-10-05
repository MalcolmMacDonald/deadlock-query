import { expect, test } from "bun:test"
import { Ray, Vector3 } from "three"
import { MeshBVH } from "three-mesh-bvh"
import { makeScene } from "../bench/scene.ts"

test("three-mesh-bvh raycast hits synthetic scene and round-trips serialisation", () => {
  const geo = makeScene(20_000)
  const bvh = new MeshBVH(geo)
  const ray = new Ray(new Vector3(500, 500, 1000), new Vector3(0, 0, -1))
  const hit = bvh.raycastFirst(ray)
  expect(hit).not.toBeNull()
  const again = MeshBVH.deserialize(MeshBVH.serialize(bvh), geo)
  expect(again.raycastFirst(ray)!.distance).toBeCloseTo(hit!.distance, 5)
})
