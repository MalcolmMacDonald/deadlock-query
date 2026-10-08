import { expect, test } from "bun:test"
import { ropeLinks } from "../src/ropes.ts"
import type { InteriorVolume } from "../src/interior.ts"

const vol = (over: Partial<InteriorVolume>): InteriorVolume => ({
  id: "1", model: "m.vmdl", interiorType: undefined, origin: [100, 200, 50], angles: [0, 0, 0], localMin: [-8, -8, 0], localMax: [8, 8, 400], ...over
})

test("a climb rope is one two-way link between the end faces of its longest axis", () => {
  const [l] = ropeLinks([vol({})])
  expect(l).toMatchObject({ kind: "climbRope", bidirectional: true })
  expect(l!.from).toEqual([100, 200, 50])
  expect(l!.to).toEqual([100, 200, 450])
})

test("the rope follows the entity rotation and short boxes are not ropes", () => {
  // pitch 90 tips the local +z axis onto world +x (Rz(yaw) Ry(pitch) Rx(roll))
  const [l] = ropeLinks([vol({ angles: [90, 0, 0] })])
  expect(l!.from.map(Math.round)).toEqual([100, 200, 50])
  expect(l!.to.map(Math.round)).toEqual([500, 200, 50])
  expect(ropeLinks([vol({ localMax: [8, 8, 40] })])).toEqual([])
})
