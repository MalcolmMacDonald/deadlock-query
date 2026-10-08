import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diffBundles, formatDiff } from "../src/diff.ts"

const bundle = (build: string, entities: object[], nav: object = { polygons: 10, links: { byKind: { zipline: 2 } } }): string => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-diff-"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    gameBuildId: build, mapName: "dl_midtown", tier: "lite", entitiesFile: "entities.json",
    tiles: [{ id: "0_0", bytes: 100 }, { id: "0_0#lod1", bytes: 40, lod: 1, lodOf: "0_0" }],
    baked: { bakeVersion: "1.1.0", sampleGrid: { channels: ["floorHeight"], bytes: 5 }, navmesh: nav }
  }))
  writeFileSync(join(dir, "entities.json"), JSON.stringify({ schemaVersion: "1.0.0", entities }))
  return dir
}

test("identical bundles match", () => {
  const e = [{ id: "1", class: "x", kind: "shop" }]
  const d = diffBundles(bundle("1", e), bundle("1", e))
  expect(d.same).toBe(true)
  expect(formatDiff(d)).toBe("bundles match")
})

test("diff lists build, entity kind, team and navmesh changes, and one-sided facts", () => {
  const a = bundle("1", [{ id: "1", class: "x", kind: "shop" }, { id: "2", class: "y", kind: "walker", team: 2 }])
  const b = bundle("2", [{ id: "1", class: "x", kind: "shop" }, { id: "3", class: "y", kind: "walker", team: 3 }, { id: "4", class: "z", kind: "guardian", team: 3 }],
    { polygons: 12, links: { byKind: { zipline: 2, mantle: 5 } } })
  const d = diffBundles(a, b)
  const by = Object.fromEntries(d.lines.map((l) => [l.what, l]))
  expect(d.same).toBe(false)
  expect(by["gameBuildId"]).toMatchObject({ before: "1", after: "2" })
  expect(by["entities"]).toMatchObject({ before: 2, after: 3 })
  expect(by["entities.guardian"]).toMatchObject({ before: undefined, after: 1 })
  expect(by["team.2"]).toMatchObject({ before: 1, after: undefined })
  expect(by["team.3"]).toMatchObject({ before: undefined, after: 2 })
  expect(by["nav.polygons"]).toMatchObject({ before: 10, after: 12 })
  expect(by["nav.links.mantle"]).toMatchObject({ before: undefined, after: 5 })
  expect(by["tiles"]).toBeUndefined()
  expect(formatDiff(d)).toContain("gameBuildId: \"1\" -> \"2\"")
})
