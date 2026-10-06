import { expect, test } from "bun:test"
import { buildMiniMap, SCHEMA_VERSION } from "@deadlock-query/contracts"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli.ts"
import { gridPlan, lookAtAngles, MAX_SHOTS, parsePlan, PlanError, ringPlan, serializePlan, shotAngles, validatePlan, yawsOf } from "../src/plan.ts"

const meta = { map: "dl_midtown", gameBuildId: "123" }

test("yaws are evenly spaced from 0", () => {
  expect(yawsOf(8)).toEqual([0, 45, 90, 135, 180, 225, 270, 315])
  expect(yawsOf(1)).toEqual([0])
  expect(() => yawsOf(0)).toThrow(PlanError)
  expect(() => yawsOf(2.5)).toThrow(PlanError)
})

test("ring: 8 yaws per position, ids and groups stable", () => {
  const p = ringPlan(meta, { at: [[0, 0, 100], [500, 0, 100]] })
  expect(p.shots).toHaveLength(16)
  expect(p.shots[0]).toEqual({ id: "ring-001-y000", group: "ring-001", position: [0, 0, 100], angles: [0, 0, 0] })
  expect(p.shots[15]!.id).toBe("ring-002-y315")
  expect(p.schemaVersion).toBe(SCHEMA_VERSION)
  expect(p.hideHud).toBe(true)
})

test("grid: cell centres row-major, lattice centred in bounds", () => {
  const p = gridPlan(meta, { bounds: [0, 0, 1000, 500], spacing: 400, z: 64, yaws: 1 })
  // 2 cols x 1 row; margin (1000-400)/2=300 on x, 50 on y
  expect(p.shots.map((s) => [s.id, ...s.position])).toEqual([
    ["grid-r000c000-y000", 300, 250, 64],
    ["grid-r000c001-y000", 700, 250, 64]
  ])
  const q = gridPlan(meta, { bounds: [-1000, -1000, 1000, 1000], spacing: 1000, z: 0, yaws: 4, pitch: 10 })
  expect(q.shots).toHaveLength(2 * 2 * 4)
  expect(q.shots[0]!.group).toBe("grid-r000c000")
  expect(q.shots[0]!.angles).toEqual([10, 0, 0])
  expect(new Set(q.shots.map((s) => s.id)).size).toBe(q.shots.length)
})

test("grid: bad geometry and runaway sizes are rejected", () => {
  expect(() => gridPlan(meta, { bounds: [0, 0, 100, 100], spacing: 0, z: 0 })).toThrow(PlanError)
  expect(() => gridPlan(meta, { bounds: [0, 0, 100, 100], spacing: 500, z: 0 })).toThrow(/no whole cell/)
  expect(() => gridPlan(meta, { bounds: [100, 0, 0, 100], spacing: 10, z: 0 })).toThrow(PlanError)
  expect(() => gridPlan(meta, { bounds: [0, 0, 100000, 100000], spacing: 100, z: 0 })).toThrow(new RegExp(`max ${MAX_SHOTS}`))
  // Rejected from the cell count alone: building 1e18 specs first would never finish.
  expect(() => gridPlan(meta, { bounds: [0, 0, 1e9, 1e9], spacing: 1, z: 0 })).toThrow(new RegExp(`max ${MAX_SHOTS}`))
})

test("output is deterministic and round-trips through parsePlan", () => {
  const a = serializePlan(gridPlan(meta, { bounds: [0, 0, 3000, 2000], spacing: 700, z: 90, yaws: 3 }))
  const b = serializePlan(gridPlan(meta, { bounds: [0, 0, 3000, 2000], spacing: 700, z: 90, yaws: 3 }))
  expect(a).toBe(b)
  expect(serializePlan(parsePlan(JSON.parse(a)))).toBe(a)
  expect(a.endsWith("\n")).toBe(true)
  expect(a).not.toContain("-0")
})

test("lookAtAngles follows Source conventions (positive pitch looks down)", () => {
  expect(lookAtAngles([0, 0, 0], [10, 0, 0])).toEqual([0, 0, 0])
  expect(lookAtAngles([0, 0, 0], [0, 10, 0])).toEqual([0, 90, 0])
  expect(lookAtAngles([0, 0, 0], [-10, 0, 0])).toEqual([0, 180, 0])
  expect(lookAtAngles([0, 0, 0], [0, -10, 0])).toEqual([0, 270, 0])
  expect(lookAtAngles([0, 0, 10], [10, 0, 0])).toEqual([45, 0, 0])
  expect(lookAtAngles([0, 0, 0], [10, 0, 10])).toEqual([-45, 0, 0])
  expect(shotAngles({ id: "a", position: [0, 0, 0], lookAt: [0, 10, 0] })).toEqual([0, 90, 0])
})

const base = { schemaVersion: SCHEMA_VERSION, map: "m", resolution: { width: 640, height: 360 }, fov: 90, hideHud: true }

test("validation: every problem is reported", () => {
  const both = { id: "a", position: [0, 0, 0], angles: [0, 0, 0], lookAt: [1, 0, 0] }
  const neither = { id: "b", position: [0, 0, 0] }
  const dup = { id: "a", position: [0, 0, 0], angles: [0, 0, 0] }
  const same = { id: "c", position: [1, 1, 1], lookAt: [1, 1, 1] }
  expect(() => parsePlan({ ...base, shots: [both, neither, dup, same] })).toThrow(/exactly one[^]*exactly one[^]*duplicate[^]*lookAt equals position/)
  expect(() => parsePlan({ ...base, shots: [] })).toThrow(/no shots/)
  expect(() => parsePlan({ ...base, fov: 0, shots: [dup] })).toThrow(PlanError)
  expect(() => parsePlan({ ...base, shots: [{ ...dup, id: "../x" }] })).toThrow(PlanError)
  expect(() => parsePlan({ ...base, resolution: { width: 0, height: 1 }, shots: [dup] })).toThrow(PlanError)
  expect(() => parsePlan("nope")).toThrow(/not a shot plan/)
  expect(validatePlan(parsePlan({ ...base, shots: [dup] }))).toEqual([])
})

const run = async (args: string[]) => {
  const out: string[] = [], err: string[] = []
  const w = process.stdout.write.bind(process.stdout), e = console.error
  process.stdout.write = ((t: string) => (out.push(t), true)) as typeof process.stdout.write
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try { return { code: await main(args, {}), out: out.join(""), err: err.join("\n") } } finally { process.stdout.write = w; console.error = e }
}

test("cli: plan ring and grid print valid plans; --out writes the file", async () => {
  const r = await run(["plan", "ring", "--map", "dl_midtown", "--at", "0,0,100", "--yaws", "4"])
  expect(r.code).toBe(0)
  expect(parsePlan(JSON.parse(r.out)).shots.map((s) => s.id)).toEqual(["ring-001-y000", "ring-001-y090", "ring-001-y180", "ring-001-y270"])
  const dir = mkdtempSync(join(tmpdir(), "dlq-plan-"))
  const file = join(dir, "plan.json")
  const g = await run(["plan", "grid", "--map", "m", "--bounds", "0,0,2000,1000", "--spacing", "1000", "--z", "80", "--resolution", "800x600", "--fov", "75", "--show-hud", "--out", file])
  expect(g.code).toBe(0)
  const plan = parsePlan(JSON.parse(readFileSync(file, "utf8")))
  expect(plan).toMatchObject({ map: "m", fov: 75, hideHud: false, resolution: { width: 800, height: 600 } })
  expect(plan.shots).toHaveLength(8)
  const back = await run(["plan", "from-file", file])
  expect(back.code).toBe(0)
  expect(back.out).toBe(readFileSync(file, "utf8"))
})

test("cli: plan errors exit 2 (bad input) or 1 (usage) with a message", async () => {
  expect((await run(["plan", "grid", "--map", "m", "--bounds", "0,0,10,10", "--spacing", "5"])).err).toContain("--z")
  expect((await run(["plan", "grid", "--map", "m", "--bounds", "0,0,10", "--spacing", "5", "--z", "1"])).code).toBe(2)
  expect((await run(["plan", "ring", "--map", "m"])).code).toBe(2)
  expect((await run(["plan", "ring", "--at", "0,0,0"])).err).toContain("--map")
  expect((await run(["plan", "ring", "--map", "m", "--at", "0,0,0", "--resolution", "big"])).code).toBe(2)
  expect((await run(["plan", "bogus"])).code).toBe(1)
  expect((await run(["plan", "ring", "--nope"])).code).toBe(1)
  const dir = mkdtempSync(join(tmpdir(), "dlq-plan-"))
  writeFileSync(join(dir, "bad.json"), "{")
  expect((await run(["plan", "from-file", join(dir, "bad.json")])).code).toBe(2)
  expect((await run(["plan", "from-file"])).code).toBe(1)
})

test("cli: --bundle supplies map, build id and bounds from the manifest", async () => {
  const { manifest } = buildMiniMap()
  const dir = mkdtempSync(join(tmpdir(), "dlq-bundle-"))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
  const [lo, hi] = [manifest.bounds.min, manifest.bounds.max]
  const r = await run(["plan", "grid", "--bundle", dir, "--spacing", String(Math.floor(Math.min(hi[0] - lo[0], hi[1] - lo[1]) / 2)), "--z", "100", "--yaws", "1"])
  expect(r.code).toBe(0)
  const plan = parsePlan(JSON.parse(r.out))
  expect(plan.map).toBe(manifest.mapName)
  expect(plan.gameBuildId).toBe(manifest.gameBuildId)
  expect(plan.shots.length).toBeGreaterThanOrEqual(4)
  for (const s of plan.shots) {
    expect(s.position[0]).toBeGreaterThan(lo[0]); expect(s.position[0]).toBeLessThan(hi[0])
    expect(s.position[1]).toBeGreaterThan(lo[1]); expect(s.position[1]).toBeLessThan(hi[1])
  }
  const bad = await run(["plan", "grid", "--bundle", join(dir, "missing"), "--spacing", "1", "--z", "1"])
  expect(bad.code).toBe(2)
  expect(bad.err).toContain("cannot read a bundle manifest")
})
