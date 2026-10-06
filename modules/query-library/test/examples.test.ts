import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildMiniMap } from "@deadlock-query/contracts"
import { MapContext } from "../src/index.ts"
import { buildNavMap } from "./navFixture.ts"
import { buildPlateauMap } from "./plateauFixture.ts"

const dir = join(import.meta.dir, "../examples")
const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()

test("there are example files", () => expect(files.length).toBeGreaterThan(0))

for (const file of files) {
  test(`example ${file} is documented and runs on the mini-map`, async () => {
    const src = readFileSync(join(dir, file), "utf8")
    expect(src).toMatch(/@example\b/)
    expect(src).toMatch(/@category\b/)
    // Examples tagged `@requires nav` run on the mini-map with a grid navmesh.
    // Examples tagged `@requires spatial` run over a plateau raycaster with stub semantics.
    const map = /@requires nav\b/.test(src) ? buildNavMap() : /@requires spatial\b/.test(src) ? buildPlateauMap() : MapContext.fromBundle(buildMiniMap())
    const run = (await import(join(dir, file))).default as (m: MapContext) => unknown
    const a = JSON.stringify(run(map))
    expect(a).toBeDefined()
    expect(JSON.stringify(run(map))).toBe(a) // deterministic
  })
}

test("guardian-nearest-orb example reproduces the fixture's expected result", async () => {
  const mini = buildMiniMap()
  const run = (await import(join(dir, "guardian-nearest-orb.ts"))).default as (m: MapContext) => unknown
  expect(run(MapContext.fromBundle(buildMiniMap()))).toEqual(mini.expectedGuardianOrbDistance.rows as never)
})
