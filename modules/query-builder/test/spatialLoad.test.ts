import { expect, test } from "bun:test"
import { toPrelude } from "../src/engine/prelude.ts"
import { buildLibraryJson } from "../src/app/build.ts"
import { buildLibraryJs, miniBundle, workerRunner } from "./helpers.ts"

test("library.json carries the spatial runtime, and it lands in the prelude only when given", async () => {
  const lib = JSON.parse(await buildLibraryJson()) as { spatial?: string; js: string }
  expect(lib.spatial).toContain("__dlqSpatial")
  expect(lib.spatial!.length).toBeGreaterThan(100_000)
  const js = await buildLibraryJs()
  expect(toPrelude(js)).not.toContain("__dlqSpatial")
  expect(toPrelude(js, lib.spatial).startsWith(lib.spatial!)).toBe(true)
})

test("baked buffers without the spatial runtime fail the load with a clear message", async () => {
  const runner = workerRunner(toPrelude(await buildLibraryJs()), miniBundle(), { bvh: new ArrayBuffer(8) })
  try {
    const r = await runner.run("map.guardians.count()", { timeoutMs: 10_000 })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/spatial runtime is missing/)
  } finally { runner.dispose() }
})

test("fetchPublishedBundle reads manifest + entities and names the baked files by URL", async () => {
  const { fetchPublishedBundle } = await import("../src/panel/loader.ts")
  const files: Record<string, unknown> = {
    "/d/manifest.json": { mapName: "m", gameBuildId: "1", entitiesFile: "entities.json", baked: { bvh: { file: "baked/collision.bvh" }, navmesh: { file: "baked/navmesh.bin" } } },
    "/d/entities.json": { entities: [{ id: "a" }] },
  }
  const server = Bun.serve({ port: 0, fetch: (r) => { const f = files[new URL(r.url).pathname]; return f ? Response.json(f) : new Response("no", { status: 404 }) } })
  try {
    const base = `http://localhost:${server.port}/d`
    const b = await (fetchPublishedBundle(`${base}/manifest.json`) as (r: () => void) => Promise<unknown>)(() => {})
    expect(b).toEqual({ manifest: { mapName: "m", gameBuildId: "1" }, entities: [{ id: "a" }], baked: { bvh: `${base}/baked/collision.bvh`, navmesh: `${base}/baked/navmesh.bin` } })
  } finally { server.stop(true) }
})
