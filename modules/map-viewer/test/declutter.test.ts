import { expect, test } from "bun:test"
import { declutter } from "../src/labels.ts"

const r = (x: number, y: number, width = 40, height = 16) => ({ x, y, width, height })

test("an overlapping label is dropped, the earlier one wins", () => {
  expect(declutter([r(0, 0), r(20, 4), r(100, 0)])).toEqual([true, false, true])
})

test("labels that merely touch the gap stay apart; off-screen ones are skipped", () => {
  expect(declutter([r(0, 0), r(41, 0)])).toEqual([true, false]) // inside the 2 px gap
  expect(declutter([r(0, 0), r(43, 0)])).toEqual([true, true])
  expect(declutter([undefined, r(0, 0)])).toEqual([false, true])
})

test("a dropped label does not block later ones", () => {
  expect(declutter([r(0, 0), r(10, 0), r(45, 0)])).toEqual([true, false, true])
})
