import { expect, test } from "bun:test"
import { LANE_NAMES, LANE_STYLE, laneFromTint, laneLabel, laneName } from "../src/lanes.ts"

test("lanes are Yellow (1), Blue (2) and Green (3); nothing is purple", () => {
  expect(LANE_NAMES).toEqual(["yellow", "blue", "green"])
  expect([1, 2, 3].map(laneName)).toEqual(["yellow", "blue", "green"])
  expect([0, 4, undefined, "1"].map(laneName)).toEqual([undefined, undefined, undefined, undefined])
  expect(LANE_NAMES.map((l) => LANE_STYLE[l].label)).toEqual(["Yellow", "Blue", "Green"])
  expect(new Set(LANE_NAMES.map((l) => LANE_STYLE[l].color)).size).toBe(3)
  expect(JSON.stringify(LANE_STYLE)).not.toMatch(/purple/i)
  expect(laneLabel(2)).toBe("Blue lane")
  expect(laneLabel(6)).toBe("lane 6")
})

test("the zipline tints of the real map are Yellow, Blue and Green", () => {
  expect(laneFromTint([255, 106, 0])).toBe("yellow")
  expect(laneFromTint([0, 25, 255])).toBe("blue")
  expect(laneFromTint([139, 0, 139])).toBe("green")
  expect(laneFromTint([255, 255, 255])).toBeUndefined()
  expect(laneFromTint([255, 0, 0])).toBeUndefined()
  expect(laneFromTint("0 0 0")).toBeUndefined()
})
