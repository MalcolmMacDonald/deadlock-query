import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { GALLERY } from "../src/gallery/queries.ts"
import { toPrelude } from "../src/engine/prelude.ts"
import { buildLibraryJs, stripTypesCompiler, workerRunner } from "./helpers.ts"

/**
 * The gallery on the real published dl_midtown bundle, through the same worker path the panel uses (spatial runtime in the prelude,
 * baked buffers parsed in the worker). Runs only when `DL_BUNDLE_DIR` points at the extracted release (never in CI: the bundle is too big).
 */
const dir = process.env.DL_BUNDLE_DIR
describe.skipIf(!dir || !existsSync(`${dir}/baked/navmesh.bin`))("gallery on the real dl_midtown bundle", () => {
  let runner: ReturnType<typeof workerRunner>
  beforeAll(async () => {
    const ab = (f: string) => { const b = readFileSync(join(dir!, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
    const spatial = await (await Bun.build({ entrypoints: [join(import.meta.dir, "../src/spatial/runtime.ts")], target: "browser", format: "iife" })).outputs[0]!.text()
    const manifest = JSON.parse(readFileSync(join(dir!, "manifest.json"), "utf8"))
    const entities = JSON.parse(readFileSync(join(dir!, "entities.json"), "utf8")).entities
    runner = workerRunner(toPrelude(await buildLibraryJs(), spatial), { manifest: { mapName: manifest.mapName, gameBuildId: manifest.gameBuildId }, entities }, { bvh: ab("baked/collision.bvh"), navmesh: ab("baked/navmesh.bin") })
  }, 120_000)
  afterAll(() => runner.dispose())

  const runGallery = async (id: string) => {
    const q = GALLERY.find((g) => g.id === id)!
    const { js } = await stripTypesCompiler.compile(q.source)
    return runner.run(js, { timeoutMs: 120_000 })
  }

  test("query 1: orbs within 10 s of a yellow guardian", async () => {
    const r = await runGallery("orbs-within-10s")
    expect(r).toMatchObject({ ok: true, value: ["1380418:13", "1380424:126", "1380424:135", "1388748:27", "1388749:3"] })
  }, 130_000)
  test("query 2: wall detour pairs", async () => {
    const t = performance.now()
    const r = await runGallery("wall-detour-pairs")
    const ms = performance.now() - t
    console.log(`query 2: ${Math.round(ms)} ms`)
    expect(r.ok && Array.isArray(r.value) && r.value.length > 0).toBe(true)
    expect(ms).toBeLessThan(25_000) // the panel's run timeout is 30 s
  }, 130_000)
  test("query 3: camps visible from high ground", async () => {
    const r = await runGallery("camps-visible-from-high-ground")
    expect(r.ok && Array.isArray(r.value) && r.value.length > 0).toBe(true)
    expect(r.ok && r.provisional).toBe(true)
  }, 130_000)
})
