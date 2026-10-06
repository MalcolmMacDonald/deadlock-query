import { expect, test } from "bun:test"
import { buildMiniMap, makeAnnotationDocument, makeMetadataBundle, type Annotation, type MetadataRecord, type Vec3 } from "@deadlock-query/contracts"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli.ts"
import { PlanError, parsePlan, shotAngles } from "../src/plan.ts"
import { standoffPlan, targetsFromAnnotations, targetsFromMetadata, type Occlusion } from "../src/targets.ts"

const meta = { map: "m", gameBuildId: "7" }
const point = (id: string, at: Vec3, layer?: string): Annotation => ({ id, kind: "point", points: [at], ...(layer ? { layer } : {}) })

test("annotations: points and labels become targets, other kinds are reported, layer filter applies", () => {
  const doc = makeAnnotationDocument([
    point("a", [0, 0, 0], "L1"),
    { id: "b", kind: "label", points: [[10, 0, 0]], text: "hi", layer: "L2" },
    { id: "c", kind: "polyline", points: [[0, 0, 0], [1, 1, 1]] },
    { id: "d", kind: "polygon", points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], layer: "L1" }
  ], { mapName: "dl_midtown", gameBuildId: "42", layers: [{ id: "L1", name: "one" }, { id: "L2", name: "two" }] })
  const all = targetsFromAnnotations(doc)
  expect(all.targets.map((t) => t.id)).toEqual(["a", "b"])
  expect(all.skipped.map((s) => s.id)).toEqual(["c", "d"])
  expect([all.mapName, all.gameBuildId]).toEqual(["dl_midtown", "42"])
  expect(targetsFromAnnotations(doc, { layer: "L2" }).targets.map((t) => t.id)).toEqual(["b"])
  expect(() => targetsFromAnnotations({ nope: 1 })).toThrow(PlanError)
  expect(() => targetsFromAnnotations(makeAnnotationDocument([point("x", [0, 0, 0], "ghost")]))).toThrow(/unknown layer/)
})

const rec = (r: Partial<MetadataRecord> & { id: string; kind: MetadataRecord["kind"] }, status = "accepted"): MetadataRecord =>
  ({ status, provenance: {}, ...r }) as MetadataRecord

test("metadata: accepted point records only; --all-status adds proposed; tampering is refused", () => {
  const bundle = makeMetadataBundle({ gameBuildId: "42", mapName: "dl_midtown" }, [
    rec({ id: "c1", kind: "creepCamp", position: [100, 0, 0] }),
    rec({ id: "o1", kind: "healingOrb", position: [0, 100, 0] }, "proposed"),
    rec({ id: "w1", kind: "walkableRegion", ring: [[0, 0, 0], [10, 0, 0], [0, 10, 0]], floorZ: 0, flag: "walkable" }),
    rec({ id: "s1", kind: "sinnersSacrifice", position: [5, 5, 5] })
  ])
  const x = targetsFromMetadata(bundle)
  expect(x.targets.map((t) => t.id)).toEqual(["creepCamp-c1", "sinnersSacrifice-s1"])
  expect(x.skipped.map((s) => s.id)).toEqual(["walkableRegion-w1"])
  expect(targetsFromMetadata(bundle, { allStatuses: true }).targets.map((t) => t.id)).toEqual(["creepCamp-c1", "healingOrb-o1", "sinnersSacrifice-s1"])
  expect(() => targetsFromMetadata({ ...bundle, mapName: "other" })).toThrow(/contentHash/)
})

test("standoffs: evenly spaced cameras that look at the target, deterministic", () => {
  const { plan, skipped, warnings } = standoffPlan(meta, [{ id: "camp", at: [1000, 2000, 10] }], { standoffs: 4, distance: 500, eyeHeight: 60 })
  expect(skipped).toEqual([])
  expect(warnings[0]).toContain("lines of sight were not checked")
  expect(plan.shots.map((s) => [s.id, ...s.position])).toEqual([
    ["camp-s1", 1500, 2000, 70], ["camp-s2", 1000, 2500, 70], ["camp-s3", 500, 2000, 70], ["camp-s4", 1000, 1500, 70]
  ])
  expect(plan.shots.every((s) => s.group === "camp" && s.lookAt![0] === 1000 && s.angles === undefined)).toBe(true)
  // each camera faces the target: yaw points from camera to target
  expect(shotAngles(plan.shots[0]!)[1]).toBe(180)
  expect(shotAngles(plan.shots[1]!)[1]).toBe(270)
  expect(standoffPlan(meta, [{ id: "camp", at: [1000, 2000, 10] }], { standoffs: 4, distance: 500, eyeHeight: 60 }).plan).toEqual(plan)
  expect(standoffPlan(meta, [{ id: "camp", at: [0, 0, 0] }], { standoffs: 1, bearingOffset: 90 }).plan.shots[0]!.position).toEqual([0, 600, 64])
})

test("standoffs: a blocked view moves closer, a fully blocked one is dropped, a target with no view is skipped", () => {
  const target = { id: "t", at: [0, 0, 0] as Vec3 }
  // A wall at x between 400 and 450 blocks every camera on the +X side that is farther than 450 from the target.
  const wall: Occlusion = { blocked: (from) => from[0] > 450 }
  const a = standoffPlan(meta, [target], { standoffs: 2, distance: 600, occlusion: wall })
  expect(a.warnings).toEqual([])
  expect(a.plan.shots.map((s) => s.position[0])).toEqual([360, -600]) // +X camera pulled in to 0.6 * 600
  const nearOnly: Occlusion = { blocked: (from) => Math.hypot(from[0], from[1]) > 250 }
  expect(standoffPlan(meta, [target], { standoffs: 1, distance: 600, occlusion: nearOnly }).plan.shots[0]!.position[0]).toBe(210)
  // Everything on the +X side is blocked at every distance: "t" keeps its -X camera, "u" (far away, all cameras have x > 0) is skipped.
  const noPlusX: Occlusion = { blocked: (from) => from[0] > 0 }
  const b = standoffPlan(meta, [target, { id: "u", at: [5000, 5000, 0] }], { standoffs: 2, distance: 600, occlusion: noPlusX })
  expect(b.plan.shots.map((s) => s.id)).toEqual(["t-s2"])
  expect(b.skipped.map((s) => s.id)).toEqual(["u"])
  expect(b.warnings).toEqual(["t: only 1 of 2 camera positions were usable"])
  const all: Occlusion = { blocked: () => true }
  expect(() => standoffPlan(meta, [target], { occlusion: all })).toThrow(/no usable camera position/)
  const some = standoffPlan(meta, [target, { id: "far", at: [100000, 0, 0] }], { standoffs: 1, occlusion: { blocked: (_f, to) => to[0] > 50000 } })
  expect(some.skipped).toEqual([{ id: "far", reason: expect.stringContaining("3 blocked") }])
})

test("standoffs: cameras outside the bounds are not used; ids are made filesystem safe and unique", () => {
  const bounds = { min: [-300, -100, -10] as Vec3, max: [700, 100, 100] as Vec3 }
  const r = standoffPlan(meta, [{ id: "p", at: [0, 0, 0] }], { standoffs: 2, distance: 600, bounds })
  // +X camera at x=600 is inside; the -X one is outside at 600 and 360 (< -300) and only fits at the 0.35 step, -210
  expect(r.plan.shots.map((s) => s.position[0])).toEqual([600, -210])
  const ids = standoffPlan(meta, [{ id: "a b/c", at: [0, 0, 0] }, { id: "a b/c", at: [9, 9, 9] }], { standoffs: 1 }).plan.shots.map((s) => s.id)
  expect(ids).toEqual(["a_b_c-s1", "a_b_c-2-s1"])
  expect(() => standoffPlan(meta, [], {})).toThrow(/no targets/)
  expect(() => standoffPlan(meta, [{ id: "a", at: [0, 0, 0] }], { standoffs: 0 })).toThrow(PlanError)
  expect(() => standoffPlan(meta, [{ id: "a", at: [0, 0, 0] }], { distance: 0 })).toThrow(PlanError)
})

const capture = async (f: () => Promise<number>) => {
  const err: string[] = [], out: string[] = []
  const w = process.stdout.write.bind(process.stdout), e = console.error
  process.stdout.write = ((t: string) => (out.push(t), true)) as typeof process.stdout.write
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try { return { code: await f(), err: err.join("\n"), out: out.join("") } } finally { process.stdout.write = w; console.error = e }
}

test("cli: plan from-annotations and from-metadata, with map and build id taken from the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-targets-"))
  const ann = join(dir, "ann.json"), md = join(dir, "md.json")
  writeFileSync(ann, JSON.stringify(makeAnnotationDocument([point("a", [0, 0, 0]), { id: "line", kind: "polyline", points: [[0, 0, 0], [1, 1, 1]] }], { mapName: "dl_midtown", gameBuildId: "42" })))
  const r = await capture(() => main(["plan", "from-annotations", ann, "--standoffs", "2"], {}))
  expect(r.code).toBe(0)
  const plan = parsePlan(JSON.parse(r.out))
  expect([plan.map, plan.gameBuildId, plan.shots.length]).toEqual(["dl_midtown", "42", 2])
  expect(r.err).toContain("skipped line")
  expect(r.err).toContain("lines of sight were not checked")

  writeFileSync(md, JSON.stringify(makeMetadataBundle({ gameBuildId: "42", mapName: "dl_midtown" }, [rec({ id: "c1", kind: "creepCamp", position: [100, 0, 0] })])))
  const m = await capture(() => main(["plan", "from-metadata", md, "--distance", "300", "--map", "override"], {}))
  expect(m.code).toBe(0)
  expect(parsePlan(JSON.parse(m.out))).toMatchObject({ map: "override", gameBuildId: "42" })

  const empty = join(dir, "empty.json")
  writeFileSync(empty, JSON.stringify(makeMetadataBundle({ gameBuildId: "1", mapName: "m" }, [])))
  const e = await capture(() => main(["plan", "from-metadata", empty], {}))
  expect(e.code).toBe(2)
  expect(e.err).toContain("no targets")
  expect((await capture(() => main(["plan", "from-metadata"], {}))).code).toBe(1)
  expect((await capture(() => main(["plan", "from-annotations", join(dir, "missing.json")], {}))).code).toBe(2)
})

test("cli: --bundle keeps cameras inside the bundle's map bounds", async () => {
  const { manifest } = buildMiniMap()
  const dir = mkdtempSync(join(tmpdir(), "dlq-targets-b-"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
  const ann = join(dir, "ann.json")
  const mid: Vec3 = [(manifest.bounds.min[0] + manifest.bounds.max[0]) / 2, (manifest.bounds.min[1] + manifest.bounds.max[1]) / 2, manifest.bounds.min[2]]
  writeFileSync(join(dir, "ann.json"), JSON.stringify(makeAnnotationDocument([point("mid", mid)])))
  const r = await capture(() => main(["plan", "from-annotations", ann, "--bundle", dir, "--distance", "100000"], {}))
  // every bearing at 100000 units is outside the bounds; the 0.35 step (35000) too for this small fixture
  expect(r.code).toBe(2)
  expect(r.err).toContain("outside the map bounds")
  const ok = await capture(() => main(["plan", "from-annotations", ann, "--bundle", dir, "--distance", "10"], {}))
  expect(ok.code).toBe(0)
  const plan = parsePlan(JSON.parse(ok.out))
  expect(plan.map).toBe(manifest.mapName)
  expect(readFileSync(ann, "utf8").length).toBeGreaterThan(0)
})
