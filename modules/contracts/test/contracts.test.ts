import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  DEFAULT_GLB_TO_WORLD, MockSelectionBus, SelectionBus, distance, metersToUnits,
  threeToWorld, transformPoint, unitsToMeters, worldToThree, type Vec3
} from "../src/index.ts"

test("world <-> three round trips", () => {
  const p: Vec3 = [1, 2, 3]
  expect(threeToWorld(worldToThree(p))).toEqual(p)
})

test("glbToWorld maps glb Y-up to world Z-up", () => {
  expect(transformPoint(DEFAULT_GLB_TO_WORLD, [1, 2, 3])).toEqual([1, -3, 2])
})

test("unit conversion round trips and distance", () => {
  expect(metersToUnits(unitsToMeters(100))).toBeCloseTo(100)
  expect(distance([0, 0, 0], [3, 4, 0])).toBe(5)
})

test("mock selection bus stores selection", async () => {
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const bus = yield* SelectionBus
      yield* bus.select(["a"])
      return yield* bus.current
    }).pipe(Effect.provide(MockSelectionBus))
  )
  expect(out).toEqual(["a"])
})
