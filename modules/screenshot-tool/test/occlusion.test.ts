import { expect, test } from "bun:test"
import { buildMiniMap, makeAnnotationDocument, type Manifest } from "@deadlock-query/contracts"
import { Raycaster } from "@deadlock-query/spatial-core"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli.ts"
import { loadBundle } from "../src/occlusion.ts"
import { parsePlan, PlanError } from "../src/plan.ts"

/** A bundle on disk whose collision is one wall: x = 300, y in [-500, 500], z in [-100, 200]. */
const wallBundle = (opts: { baked?: boolean; corrupt?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "dlq-los-"))
  const positions = new Float32Array([300, -500, -100, 300, 500, -100, 300, 500, 200, 300, -500, 200])
  const bytes = Buffer.from(Raycaster.fromGeometry(positions, new Uint32Array([0, 1, 2, 0, 2, 3])).serialize())
  const base = buildMiniMap().manifest
  const file = (name: string, data: Buffer) => ({ file: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") })
  const manifest: Manifest = {
    ...base,
    bounds: { min: [-2000, -2000, -500], max: [2000, 2000, 500] },
    ...(opts.baked === false ? {} : {
      baked: {
        bakeVersion: "test", semanticsVersion: "test", placeholder: true, inputKey: "k",
        bvh: { ...file("baked/collision.bvh", bytes), triangles: 2, vertices: 4, excludedLayers: [], skippedNodes: 0 },
        sampleGrid: { ...file("baked/grid.bin", Buffer.alloc(4)), cellSize: 64, nx: 1, ny: 1, origin: [0, 0], channels: ["floorHeight"], params: {} }
      }
    })
  }
  mkdirSync(join(dir, "baked"), { recursive: true })
  writeFileSync(join(dir, "baked", "collision.bvh"), opts.corrupt ? Buffer.concat([bytes, Buffer.from([1])]) : bytes)
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
  const ann = join(dir, "ann.json")
  writeFileSync(ann, JSON.stringify(makeAnnotationDocument([{ id: "spot", kind: "point", points: [[0, 0, 0]] }], { mapName: "m", gameBuildId: "1" })))
  return { dir, ann }
}

const capture = async (f: () => Promise<number>) => {
  const err: string[] = [], out: string[] = []
  const w = process.stdout.write.bind(process.stdout), e = console.error
  process.stdout.write = ((t: string) => (out.push(t), true)) as typeof process.stdout.write
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  try { return { code: await f(), err: err.join("\n"), out: out.join("") } } finally { process.stdout.write = w; console.error = e }
}

test("loadBundle: the baked BVH answers line-of-sight questions", () => {
  const { dir } = wallBundle()
  const { occlusion } = loadBundle(dir)
  expect(occlusion).toBeDefined()
  expect(occlusion!.blocked([600, 0, 64], [0, 0, 32])).toBe(true)
  expect(occlusion!.blocked([210, 0, 64], [0, 0, 32])).toBe(false)
  expect(occlusion!.blocked([-600, 0, 64], [0, 0, 32])).toBe(false)
  expect(loadBundle(wallBundle({ baked: false }).dir).occlusion).toBeUndefined()
})

test("loadBundle: a BVH that does not match the manifest is refused", () => {
  expect(() => loadBundle(wallBundle({ corrupt: true }).dir)).toThrow(PlanError)
  expect(() => loadBundle(join(tmpdir(), "dlq-nope-nothing"))).toThrow(/cannot read a bundle manifest/)
})

test("cli: --bundle with a baked BVH moves the blocked camera in front of the wall; --no-los does not", async () => {
  const { dir, ann } = wallBundle()
  const r = await capture(() => main(["plan", "from-annotations", ann, "--bundle", dir, "--standoffs", "2", "--distance", "600"], {}))
  expect(r.code).toBe(0)
  expect(r.err).not.toContain("lines of sight were not checked")
  expect(parsePlan(JSON.parse(r.out)).shots.map((s) => s.position[0])).toEqual([210, -600])

  const off = await capture(() => main(["plan", "from-annotations", ann, "--bundle", dir, "--standoffs", "2", "--distance", "600", "--no-los"], {}))
  expect(parsePlan(JSON.parse(off.out)).shots.map((s) => s.position[0])).toEqual([600, -600])
  expect(off.err).toContain("lines of sight were not checked")
})

test("cli: a bundle without baked collision warns and a corrupt one is an error", async () => {
  const none = wallBundle({ baked: false })
  const r = await capture(() => main(["plan", "from-annotations", none.ann, "--bundle", none.dir, "--standoffs", "1"], {}))
  expect(r.code).toBe(0)
  expect(r.err).toContain("has no baked collision")
  const bad = wallBundle({ corrupt: true })
  const e = await capture(() => main(["plan", "from-annotations", bad.ann, "--bundle", bad.dir], {}))
  expect(e.code).toBe(2)
  expect(e.err).toContain("does not match the manifest")
})
