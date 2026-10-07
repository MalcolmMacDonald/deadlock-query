import { expect, test } from "bun:test"
import { entityLabel } from "../src/results/entityLabel.ts"

test("kind, id suffix and lane", () => {
  expect(entityLabel({ id: "1380549:27", class: "citadel_pickup_spawner", kind: "healingOrb", lane: 2 }, "1380549:27")).toBe("healingOrb #27 · blue")
})
test("falls back to the class, and to nothing for unknown ids", () => {
  expect(entityLabel({ id: "5:9", class: "info_thing" }, "5:9")).toBe("info_thing #9")
  expect(entityLabel(undefined, "5:9")).toBeUndefined()
})
