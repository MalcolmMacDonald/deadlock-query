import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildMiniMap, writeBoxGlb } from "@deadlock-query/contracts"
import { InteriorVolumes, INTERIOR_VOLUMES_FILE, interiorModels, localBox } from "../src/interior.ts"
import { extract } from "../src/extract.ts"
import type { S2VRunner } from "../src/s2v.ts"
import { parseVents, toEntities } from "../src/vents.ts"

const vol = (over: Partial<ConstructorParameters<typeof InteriorVolumes>[0][number]> = {}) => ({
  id: "v", model: "m", interiorType: 0 as number | undefined, origin: [100, 200, 0] as [number, number, number], angles: [0, 0, 0] as [number, number, number],
  localMin: [-50, -20, 0] as [number, number, number], localMax: [50, 20, 100] as [number, number, number], ...over
})

test("a volume is a box in the entity's frame, placed by origin and yaw", () => {
  const v = new InteriorVolumes([vol()])
  expect(v.contains(100, 200, 10)).toBe(true)
  expect(v.contains(149, 200, 10)).toBe(true)
  expect(v.contains(100, 230, 10)).toBe(false)
  expect(v.contains(100, 200, 150)).toBe(false)
  // yaw 90: the long axis points along +y, so (100, 249) is inside and (149, 200) is not
  const turned = new InteriorVolumes([vol({ angles: [0, 90, 0] })])
  expect(turned.contains(100, 249, 10)).toBe(true)
  expect(turned.contains(149, 200, 10)).toBe(false)
  expect(turned.contains(120, 200, 10)).toBe(true)
})

test("localBox maps the loaded bounds through glbToWorld", () => {
  const swap = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1] // glTF (x,y,z) -> (x,-z,y)
  const b = localBox({ loadedBounds: { min: [0, 0, -200], max: [100, 50, 0] } }, swap)!
  expect(b.min).toEqual([0, 0, 0])
  expect(b.max).toEqual([100, 200, 50])
})

const VENTS = `
====0====
classname  "citadel_trigger_interior"
origin  [ 100, 200, 0 ]
interior_type  1
model  resource_name:"maps/dl_midtown/entities/in_a.vmdl"
hammeruniqueid  "5"
====1====
classname  "citadel_trigger_interior"
origin  [ 0, 0, 0 ]
interior_type  0
model  resource_name:"maps/dl_midtown/entities/in_b.vmdl"
hammeruniqueid  "6"
`

test("interiorModels lists volume entities that name a model", () => {
  const es = toEntities(parseVents(VENTS))
  expect(interiorModels(es).map((m) => m.model)).toEqual(["maps/dl_midtown/entities/in_a.vmdl", "maps/dl_midtown/entities/in_b.vmdl"])
})

test("extract exports interior volume models into collision/interior-volumes.json, skipping ones that fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "dlq-int-"))
  const m = buildMiniMap()
  const calls: string[] = []
  const runner: S2VRunner = async (a) => {
    const inner = a[a.indexOf("-f") + 1]!
    const out = a[a.indexOf("-o") + 1]!
    mkdirSync(dirname(out), { recursive: true })
    calls.push(inner)
    if (inner.endsWith(".vents_c")) writeFileSync(out, VENTS)
    else if (inner.endsWith("world_physics.vmdl_c")) writeFileSync(`${out}_physics.glb`, m.collisionGlb)
    else if (inner.endsWith("in_a.vmdl_c")) writeFileSync(`${out}_physics.glb`, writeBoxGlb([{ name: "b", min: [-50, -20, 0], max: [50, 20, 100] }]))
    else if (inner.endsWith("in_b.vmdl_c")) return { code: 2, stdout: "", stderr: "not found" }
    else if (inner.endsWith(".nav")) writeFileSync(out, "nav")
    else if (inner.endsWith(".vwnod_c")) writeFileSync(out, JSON.stringify({ asset: { version: "2.0" }, nodes: [], meshes: [], accessors: [] }))
    return { code: 0, stdout: "", stderr: "" }
  }
  const opts = { vpk: "m.vpk", map: "dl_midtown", buildId: "1", s2vVersion: "20.0", tier: "lite" as const, outRoot: root, runner }
  const r = await extract(opts)
  const file = join(r.dir, INTERIOR_VOLUMES_FILE)
  expect(existsSync(file)).toBe(true)
  const f = JSON.parse(readFileSync(file, "utf8"))
  expect(f.volumes.length).toBe(1)
  expect(f.volumes[0]).toMatchObject({ id: "5", interiorType: 1, origin: [100, 200, 0] })
  expect(r.warnings.some((w) => w.includes("1 of 2 volume models"))).toBe(true)
  const before = calls.length
  await extract(opts)
  expect(calls.length).toBe(before) // cached
})
