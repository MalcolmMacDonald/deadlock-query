import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { encode } from "fast-png"
import { buildPaints, firstMaterialOfModel, indexVmats, pool, refOfMeshName } from "../src/materials.ts"
import { baseColorTexture, colorTint, parseVmatText } from "../src/vmat.ts"
import type { S2VRunner } from "../src/s2v.ts"
import { linearToSrgb8, meanColor } from "../src/colors.ts"

// Trimmed from Source2Viewer's `-b DATA` output of the real materials (same syntax).
const header = (refs: string) => `\tResource Type: Material [Version 1] [Header Version: 12]\n\n--- Resource External Refs: ---\n\tId:               Resource Name:\n${refs}\n\n--- Data for block "DATA" ---\n<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->\n`
const STONE = header("\t24EF89F1FAB76061  materials/stone/stone_tile_01/stone_tile_01_color_tga_d2e6517.vtex") + `{
\tm_materialName = "materials/stone/stone_tile_01/stone_tile_01_tintable.vmat"
\tm_shaderName = "environment_blend.vfx"
\tm_intParams = 
\t[
\t\t{
\t\t\tm_name = "F_WORLD_OVERLAY"
\t\t\tm_nValue = 1
\t\t},
\t]
\tm_floatParams = 
\t[
\t\t{
\t\t\tm_name = "g_flWorldOverlayTiling"
\t\t\tm_flValue = 1235.109985
\t\t},
\t]
\tm_vectorParams = 
\t[
\t\t{
\t\t\tm_name = "g_vAlbedoContrastSaturationBrightness1"
\t\t\tm_value = [ 0.93, 0.0, 1.24, 0.0 ]
\t\t},
\t\t{
\t\t\tm_name = "g_vColorTint2"
\t\t\tm_value = [ 1.0, 0.0, 0.0, 0.0 ]
\t\t},
\t]
\tm_textureParams = 
\t[
\t\t{
\t\t\tm_name = "g_tColor1"
\t\t\tm_pValue = resource:"materials/stone/stone_tile_01/stone_tile_01_color_tga_d2e6517.vtex"
\t\t},
\t\t{
\t\t\tm_name = "g_tColor2"
\t\t\tm_pValue = resource:"materials/stone/stone_tile_01/stone_tile_01_color_tga_d2e6517.vtex"
\t\t},
\t\t{
\t\t\tm_name = "g_tColorWorldOverlay"
\t\t\tm_pValue = resource:"materials/brick/_source/overlay_world_brick_02_psd_813e30eb.vtex"
\t\t},
\t\t{
\t\t\tm_name = "g_tRevealMask2"
\t\t\tm_pValue = resource:"materials/default/default_blend_tga_77d82ed9.vtex"
\t\t},
\t]
}`
const MASKED = header("") + `{
\tm_shaderName = "environment_blend.vfx"
\tm_vectorParams = 
\t[
\t\t{
\t\t\tm_name = "g_vColorTint"
\t\t\tm_value = [ 0.5, 0.5, 1.0, 0.0 ]
\t\t},
\t]
\tm_textureParams = 
\t[
\t\t{
\t\t\tm_name = "g_tColor1"
\t\t\tm_pValue = resource:"materials/metal/metal_painted_02_mask_png_193a8e98.vtex"
\t\t},
\t\t{
\t\t\tm_name = "g_tColor2"
\t\t\tm_pValue = resource:"materials/metal/metal_painted_02_color_png_21620079.vtex"
\t\t},
\t]
}`
const SIMPLE = header("") + `{
\tm_shaderName = "environment_simple.vfx"
\tm_vectorParams = [  ]
\tm_textureParams = 
\t[
\t\t{
\t\t\tm_name = "g_tColor"
\t\t\tm_pValue = resource:"materials/abstract/hotspot_color.vtex"
\t\t},
\t]
}`

test("mesh names: world materials, prop models and glass meshes", () => {
  expect(refOfMeshName("n0_lr0_agg_merge_stone_tile_01_tintable_2_fragment4")).toEqual({ kind: "agg_merge", stem: "stone_tile_01_tintable" })
  expect(refOfMeshName("n0_lr0_agg_merge_concrete_architecture_01_2")).toEqual({ kind: "agg_merge", stem: "concrete_architecture_01" })
  expect(refOfMeshName("n0_lr0_agg_prop_candle_1_simple_0_fragment213")).toEqual({ kind: "agg_prop", model: "n0_lr0_agg_prop_candle_1_simple_0" })
  expect(refOfMeshName("n0_lr0_c0_s_cb_vism0_mt_black.meshset_0")).toEqual({ kind: "mt", stem: "black" })
  expect(refOfMeshName("something_else")).toBeUndefined()
})

test("material text: texture refs, vectors, base-colour choice skips masks and defaults, tint only from g_vColorTint", () => {
  const stone = parseVmatText(STONE)
  expect(stone.shader).toBe("environment_blend.vfx")
  expect(stone.textures["g_tColor1"]).toBe("materials/stone/stone_tile_01/stone_tile_01_color_tga_d2e6517.vtex")
  expect(stone.vectors["g_vColorTint2"]).toEqual([1, 0, 0, 0])
  expect(baseColorTexture(stone)).toBe("materials/stone/stone_tile_01/stone_tile_01_color_tga_d2e6517.vtex")
  expect(colorTint(stone)).toBeUndefined()
  const masked = parseVmatText(MASKED)
  expect(baseColorTexture(masked)).toBe("materials/metal/metal_painted_02_color_png_21620079.vtex") // g_tColor1 is a mask
  expect(colorTint(masked)).toEqual([0.5, 0.5, 1])
  expect(baseColorTexture(parseVmatText(SIMPLE))).toBe("materials/abstract/hotspot_color.vtex")
  expect(baseColorTexture(parseVmatText(header("") + "{ m_textureParams = [ ] }"))).toBeUndefined()
})

test("vmat index prefers materials/ then the shortest path; model refs give the vmat_c path", () => {
  const idx = indexVmats("models/hideout/materials/wall.vmat_c CRC:1\nmaterials/a/wall.vmat_c CRC:2\nmaterials/wall.vmat_c CRC:3\nmaterials/x.vmdl_c CRC:4")
  expect(idx.get("wall")).toBe("materials/wall.vmat_c")
  expect(idx.has("x")).toBe(false)
  expect(firstMaterialOfModel("--- Resource External Refs: ---\n\tId:   Resource Name:\n\t37978DF4B17186CF  models/candles/materials/candle_1_simple.vmat\n")).toBe("models/candles/materials/candle_1_simple.vmat_c")
  expect(firstMaterialOfModel("nothing here")).toBeUndefined()
})

test("pool never runs more than n at once", async () => {
  let live = 0, peak = 0
  await pool(Array.from({ length: 12 }, (_, i) => i), 3, async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live-- })
  expect(peak).toBe(3)
})

/** A Source2Viewer stand-in serving a tiny fake game: calls are recorded so caching can be asserted. */
const fakeS2V = (calls: string[][]): S2VRunner => async (a) => {
  calls.push([...a])
  const flag = (n: string) => a[a.indexOf(n) + 1]
  const out = flag("-o"), file = flag("-f"), input = flag("-i")
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" })
  if (a.includes("--vpk_list")) return ok("materials/stone/stone_tile_01/stone_tile_01_tintable.vmat_c CRC:1\nmaterials/simple/simple_prop_painted_01a.vmat_c CRC:2\nmodels/candles/materials/candle_1_simple.vmat_c CRC:3\nmaterials/other/never_used.vmat_c CRC:4\nmodels/a.vmdl_c CRC:5")
  if (a.includes("-b")) {
    const name = input!.replace(/\\/g, "/")
    if (name.endsWith("stone_tile_01_tintable.vmat_c")) return ok(STONE)
    if (name.endsWith("simple_prop_painted_01a.vmat_c")) return ok(SIMPLE)
    if (name.endsWith("candle_1_simple.vmat_c")) return ok(SIMPLE)
    if (name.endsWith("n0_lr0_agg_prop_candle_1_simple_0.vmdl_c")) return ok(header("\t37978DF4B17186CF  models/candles/materials/candle_1_simple.vmat\n\t1111111111111111  materials/second.vmat"))
    return { code: 1, stdout: "", stderr: "unexpected -b" }
  }
  if (out && !a.includes("-d")) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, "raw"); return ok() }
  if (out && file?.endsWith(".vtex_c")) {
    mkdirSync(dirname(out), { recursive: true })
    // stone texture: pure red; hotspot texture: mid grey
    const px = file.includes("stone") ? [255, 0, 0, 255] : [128, 128, 128, 255]
    writeFileSync(out, encode({ width: 4, height: 4, channels: 4, depth: 8, data: new Uint8Array(Array.from({ length: 16 }, () => px).flat()) }))
    return ok()
  }
  return { code: 1, stdout: "", stderr: `unexpected ${a.join(" ")}` }
}

test("buildPaints: names to materials to textures, props through their model, caches between runs", async () => {
  const work = mkdtempSync(join(tmpdir(), "dlq-paints-"))
  const calls: string[][] = []
  const names = [
    "n0_lr0_agg_merge_stone_tile_01_tintable_2_fragment4", "n0_lr0_agg_merge_stone_tile_01_tintable_3",
    "n0_lr0_agg_merge_simple_prop_painted_01a_0_fragment1", "n0_lr0_agg_merge_no_such_material_0_fragment1",
    "n0_lr0_agg_prop_candle_1_simple_0_fragment9"
  ]
  const opts = { runner: fakeS2V(calls), gameVpk: "pak01_dir.vpk", mapVpk: "dl_midtown.vpk", map: "dl_midtown", workDir: work, meshNames: names, concurrency: 2 }
  const { provider, report } = await buildPaints(opts)
  expect(report.stems).toBe(4) // 3 material names + 1 prop model
  expect(report.resolved).toBe(3)
  expect(report.unresolved).toEqual(["no_such_material"])
  expect(report.textures).toBe(2)
  const stone = provider.paintFor([names[0]!])!
  expect(stone.tint).toEqual([1, 1, 1])
  expect(linearToSrgb8(meanColor(stone.texture!)[0])).toBe(255)
  expect(linearToSrgb8(meanColor(stone.texture!)[1])).toBe(0)
  expect(linearToSrgb8(meanColor(provider.paintFor([names[2]!])!.texture!)[0])).toBe(128)
  expect(provider.paintFor([names[4]!])).toBeDefined() // the prop's first material
  expect(provider.paintFor([names[3]!])).toBeUndefined()
  expect(provider.paintFor(["unrelated"])).toBeUndefined()
  expect(provider.fallback.length).toBe(3)
  // the prop model came from the map vpk, materials from pak01
  expect(calls.some((c) => c.includes("dl_midtown.vpk") && c.includes("maps/dl_midtown/worldnodes/n0_lr0_agg_prop_candle_1_simple_0.vmdl_c"))).toBe(true)
  expect(calls.filter((c) => c.includes("pak01_dir.vpk") && c.includes("-f") && c.some((x) => x.endsWith(".vmat_c")))).toHaveLength(3)
  expect(existsSync(join(work, "pak01-vmats.txt"))).toBe(true)

  // second run: everything from the cache, no Source2Viewer call at all
  const again: string[][] = []
  const second = await buildPaints({ ...opts, runner: fakeS2V(again) })
  expect(again).toEqual([])
  expect(second.report.resolved).toBe(3)
  expect(linearToSrgb8(meanColor(second.provider.paintFor([names[0]!])!.texture!)[0])).toBe(255)
})

test("buildPaints survives a material or texture that cannot be read", async () => {
  const work = mkdtempSync(join(tmpdir(), "dlq-paints-"))
  const base = fakeS2V([])
  const runner: S2VRunner = async (a) => (a.join(" ").includes("simple_prop_painted_01a") || a.includes("-d") && a.join(" ").includes("stone") ? { code: 1, stdout: "", stderr: "boom" } : base(a))
  const { provider, report } = await buildPaints({ runner, gameVpk: "p", mapVpk: "m", map: "dl_midtown", workDir: work, meshNames: ["x_agg_merge_stone_tile_01_tintable_0", "x_agg_merge_simple_prop_painted_01a_0"] })
  expect(report.resolved).toBe(0)
  expect(report.unresolved.length).toBe(2)
  expect(provider.paintFor(["x_agg_merge_stone_tile_01_tintable_0"])).toBeUndefined()
})
