import { expect, test } from "bun:test"
import { Raycaster } from "@deadlock-query/spatial-core"
import { loadMetadataSupport, probeFromRaycaster } from "../src/metadataContext.ts"

// A closed unit-ish box from z=0 to z=100 over x,y in [-50, 50], as a triangle soup.
const box = (): Raycaster => {
  const v = [-50, -50, 0, 50, -50, 0, 50, 50, 0, -50, 50, 0, -50, -50, 100, 50, -50, 100, 50, 50, 100, -50, 50, 100]
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return Raycaster.fromGeometry(new Float32Array(v), new Uint32Array(f))
}

test("probe: ground below a point, solid only inside the closed mesh", () => {
  const probe = probeFromRaycaster(box())
  expect(probe.groundZ(0, 0, 500)).toBeCloseTo(100)
  expect(probe.groundZ(900, 0, 500)).toBeUndefined()
  expect(probe.insideSolid([0, 0, 50])).toBe(true)
  expect(probe.insideSolid([0, 0, 300])).toBe(false)
  expect(probe.insideSolid([900, 0, 50])).toBe(false)
})

test("loadMetadataSupport: bundle records, probe from the baked BVH, degrades when files are missing", async () => {
  const manifest = { mapName: "m", gameBuildId: "1", bounds: { min: [0, 0, 0], max: [1, 1, 1] }, baked: { bvh: { file: "baked/c.bvh" } } }
  const bvh = box().serialize()
  const records = [{ id: "a", status: "accepted" }, { id: "b", status: "rejected" }]
  const files: Record<string, () => Response> = {
    "http://x/data/manifest.json": () => Response.json(manifest),
    "http://x/data/baked/c.bvh": () => new Response(bvh),
    "http://x/data/metadata.bundle.json": () => Response.json({ records }),
  }
  const fetcher = async (u: string) => files[u]?.() ?? new Response("no", { status: 404 })
  const full = (await loadMetadataSupport("http://x/data/manifest.json", fetcher))!
  expect(full.accepted.map((r) => r.id)).toEqual(["a"])
  expect(full.collision?.groundZ(0, 0, 500)).toBeCloseTo(100)

  delete files["http://x/data/baked/c.bvh"]
  delete files["http://x/data/metadata.bundle.json"]
  const degraded = (await loadMetadataSupport("http://x/data/manifest.json", fetcher))!
  expect(degraded.collision).toBeUndefined()
  expect(degraded.accepted).toEqual([])
  expect(await loadMetadataSupport("http://x/none.json", fetcher)).toBeUndefined()
})
