import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildMiniMap } from "@deadlock-query/contracts"
import { extract } from "../src/extract.ts"
import { inspectBundle } from "../src/inspect.ts"
import { invertAffine } from "../src/mat4.ts"
import { gltfInfo, readGltfJson } from "../src/gltfInfo.ts"
import { entityKind } from "../src/entityKinds.ts"
import { args, firstErrorLine, type S2VRunner } from "../src/s2v.ts"
import { parseVents, parseVentValue, toEntities } from "../src/vents.ts"

const VENTS = `
====0====
classname  "citadel_pickup_spawner"
origin  [ 10.5, -20, 30 ]
subclass_name  "citadel_pickup_floating_health"
spawn_delay_override  180.0
model  resource_name:"maps/x/entities/a.vmdl"
hammeruniqueid  "77"
@OnPickedUp  foo,Kill,,0,-1
====1====
classname  "npc_boss_tier2"
origin  [ 1, 2, 3 ]
angles  [ 0, 90, 0 ]
teamnumber  2
lanenum  3
====2====
classname  "info_super_trooper_spawn"
subclass_name  "boss_rebel_t1_blue"
origin  [ 0, 0, 0 ]
====3====
classname  "light_omni2"
hammeruniqueid  "77"
`

test("vents values", () => {
  expect(parseVentValue('"a b"')).toBe("a b")
  expect(parseVentValue("[ 1, -2.5, 3 ]")).toEqual([1, -2.5, 3])
  expect(parseVentValue('resource_name:"m/x.vmdl"')).toBe("m/x.vmdl")
  expect(parseVentValue("180.0")).toBe(180)
})

test("vents -> entities with kinds, unique ids, unknown classes kept", () => {
  const es = toEntities(parseVents(VENTS))
  expect(es.map((e) => e.kind)).toEqual(["healingOrb", "walker", "guardian", undefined])
  expect(es[0]).toMatchObject({ id: "77", position: [10.5, -20, 30] })
  expect(es[0]!.properties["outputs"]).toEqual(["@OnPickedUp  foo,Kill,,0,-1"])
  expect(es[1]).toMatchObject({ team: 2, lane: 3, rotation: [0, 90, 0] })
  expect(new Set(es.map((e) => e.id)).size).toBe(4)
  expect(es[3]!.class).toBe("light_omni2")
})

test("entityKind guards subclasses", () => {
  expect(entityKind("info_super_trooper_spawn", "boss_combine_t1_yellow")).toBe("guardian")
  expect(entityKind("info_super_trooper_spawn", "something_else")).toBeUndefined()
  expect(entityKind("citadel_pickup_spawner", "other")).toBeUndefined()
})

test("invertAffine undoes a scale+swap matrix", () => {
  const m = [3e-9, 0, 0.0254, 0, 0.0254, 3e-9, 0, 0, 0, 0.0254, 3e-9, 0, 5, 6, 7, 1]
  const inv = invertAffine(m)
  const p = (mm: number[], v: number[]) => [0, 1, 2].map((r) => mm[r]! * v[0]! + mm[4 + r]! * v[1]! + mm[8 + r]! * v[2]! + mm[12 + r]!)
  const back = p(inv as number[], p(m, [100, 200, 300]))
  back.forEach((v, i) => expect(v).toBeCloseTo([100, 200, 300][i]!, 3))
})

test("S2V arg builders match the verified commands; error line skips stack frames", () => {
  expect(args.collision("m.vpk", "dl_midtown", "o/phys")).toEqual(["-i", "m.vpk", "-f", "maps/dl_midtown/world_physics.vmdl_c", "-o", "o/phys", "-d", "--gltf_export_format", "glb"])
  expect(firstErrorLine({ code: 2, stdout: "", stderr: "Boom happened\n   at Foo.Bar()" })).toBe("Boom happened")
})

/** Fake CLI: writes fixture-derived outputs where the real tool would. */
const fakeRunner = (calls: string[][]): S2VRunner => async (a) => {
  calls.push([...a])
  const out = a[a.indexOf("-o") + 1]!
  const inner = a[a.indexOf("-f") + 1]!
  mkdirSync(dirname(out), { recursive: true })
  const m = buildMiniMap()
  if (inner.endsWith(".vents_c")) writeFileSync(out, VENTS)
  else if (inner.endsWith("world_physics.vmdl_c")) { writeFileSync(`${out}.glb`, new Uint8Array(0)); writeFileSync(`${out}_physics.glb`, m.collisionGlb) }
  else if (inner.endsWith(".vwnod_c")) writeFileSync(out, JSON.stringify({ asset: { version: "2.0" }, nodes: [], meshes: [], accessors: [] }))
  return { code: 0, stdout: "", stderr: "" }
}

test("extract (lite) writes a valid bundle and caches stages", async () => {
  const root = mkdtempSync(join(tmpdir(), "dlq-"))
  const calls: string[][] = []
  const opts = { vpk: "m.vpk", map: "dl_midtown", buildId: "1", s2vVersion: "20.0", tier: "lite" as const, outRoot: root, runner: fakeRunner(calls) }
  const r = await extract(opts)
  expect(calls.length).toBe(2)
  const manifest = JSON.parse(readFileSync(join(r.dir, "manifest.json"), "utf8"))
  expect(manifest.collision.file).toBe("collision/physics.glb")
  expect(manifest.tiles).toEqual([])
  expect(gltfInfo(readGltfJson(join(r.dir, "collision/physics.glb"))).meshCount).toBeGreaterThan(0)
  const rep = await inspectBundle(r.dir)
  expect(rep.errors).toEqual([])
  expect(rep.info["entities"]).toBe(4)
  await extract(opts)
  expect(calls.length).toBe(2) // cached
  await extract({ ...opts, force: true })
  expect(calls.length).toBe(4)
})

test("failed CLI run surfaces ExportFailed with the first error line", async () => {
  const root = mkdtempSync(join(tmpdir(), "dlq-"))
  const runner: S2VRunner = async () => ({ code: 2, stdout: "", stderr: "File not found in VPK\n  at X()" })
  await expect(extract({ vpk: "m.vpk", map: "dl_midtown", buildId: "1", s2vVersion: "20.0", tier: "lite", outRoot: root, runner })).rejects.toMatchObject({ _tag: "ExportFailed", stage: "entities" })
})
