import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { buildMips, meanColor, srgbToLinear, type ColorProvider, type MaterialPaint, type MipChain, type Rgb } from "./colors.ts"
import { decodePng } from "./png.ts"
import { args, run, type S2VRunner } from "./s2v.ts"
import { baseColorTexture, colorTint, parseVmatText } from "./vmat.ts"

/**
 * Paints for the lite render, from the game's own materials. The glTF export has no materials (exporting them breaks this
 * Source2Viewer build), but its mesh names carry them: `n0_lr0_agg_merge_<material>_<k>[_fragment<j>]` for world geometry (the
 * stem is the basename of a `.vmat_c`), `..._mt_<material>` for a few glass meshes. Prop meshes (`agg_prop_<model>_...`) name a
 * model, whose materials live inside the `.vmdl_c`; they get the fallback colour (times their vertex colours).
 */

export type MeshRef =
  /** `<material basename>`: a `.vmat_c` of that name in `pak01`. */
  | { readonly kind: "agg_merge" | "mt"; readonly stem: string }
  /** `<model>`: the map's own `worldnodes/<model>.vmdl_c`, whose external refs name the material. */
  | { readonly kind: "agg_prop"; readonly model: string }
/** What a mesh name says about its material, if it follows one of the naming schemes. */
export const refOfMeshName = (name: string): MeshRef | undefined => {
  const agg = /_agg_merge_(.+?)_\d+(?:_fragment\d+)?$/.exec(name)
  if (agg) return { kind: "agg_merge", stem: agg[1]! }
  const prop = /^(.*_agg_prop_.+?)(?:_fragment\d+)?$/.exec(name)
  if (prop) return { kind: "agg_prop", model: prop[1]! }
  const mt = /_mt_(.+?)(?:\.meshset_\d+)?$/.exec(name)
  return mt ? { kind: "mt", stem: mt[1]! } : undefined
}

/** First `.vmat` an `-b DATA` dump of a model lists under "Resource External Refs", as the `.vmat_c` inner path. */
export const firstMaterialOfModel = (dump: string): string | undefined => {
  const m = /^\s*[0-9A-F]{8,}\s+(\S+\.vmat)\s*$/im.exec(dump)
  return m ? `${m[1]!.replace(/\\/g, "/")}_c` : undefined
}

/** Basename (no extension) to inner paths of `.vmat_c` files, from a `--vpk_list` listing. Ambiguous names prefer `materials/`, then the shortest path. */
export const indexVmats = (listing: string): Map<string, string> => {
  const by = new Map<string, string[]>()
  for (const line of listing.split(/\r?\n/)) {
    const m = /^\s*(\S+\.vmat_c)\b/.exec(line)
    if (!m) continue
    const path = m[1]!.replace(/\\/g, "/")
    const base = path.slice(path.lastIndexOf("/") + 1, -".vmat_c".length)
    ;(by.get(base) ?? by.set(base, []).get(base)!).push(path)
  }
  const rank = (p: string) => (p.startsWith("materials/") ? 0 : 1)
  return new Map([...by].map(([b, ps]) => [b, ps.sort((x, y) => rank(x) - rank(y) || x.length - y.length || (x < y ? -1 : 1))[0]!]))
}

/** Runs `fn` over `items` with at most `n` in flight. */
export const pool = async <T>(items: ReadonlyArray<T>, n: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!)
  }))
}

export interface PaintOptions {
  readonly runner: S2VRunner
  /** `pak01_dir.vpk`: the map's materials live there, not in the map's own vpk. */
  readonly gameVpk: string
  /** Scratch folder; raw materials, their text dumps and texture mip chains are cached here between runs. */
  readonly workDir: string
  /** The map's own vpk (`maps/<map>.vpk`) and name: prop models (`worldnodes/<model>.vmdl_c`) are generated per map. */
  readonly mapVpk: string
  readonly map: string
  /** Mesh names of the render export; stems are taken from them. */
  readonly meshNames: Iterable<string>
  readonly concurrency?: number
  /** Largest mip chain edge (default 128). */
  readonly maxTexture?: number
  readonly log?: ((m: string) => void) | undefined
}

export interface PaintReport {
  readonly stems: number
  readonly resolved: number
  readonly textured: number
  readonly textures: number
  /** Stems with no `.vmat_c` of that name, or whose material or texture could not be read. */
  readonly unresolved: ReadonlyArray<string>
  readonly seconds: number
}

const MIP_MAGIC = 0x4d495031
const packMips = (m: MipChain): Uint8Array => {
  const out = new Uint8Array(8 + m.levels.reduce((n, l) => n + l.length, 0))
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MIP_MAGIC, true); dv.setUint32(4, m.size, true)
  let o = 8
  for (const l of m.levels) { out.set(l, o); o += l.length }
  return out
}
const unpackMips = (b: Uint8Array): MipChain | undefined => {
  if (b.length < 8) return undefined
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(0, true) !== MIP_MAGIC) return undefined
  const size = dv.getUint32(4, true)
  const levels: Uint8Array[] = []
  let o = 8
  for (let s = size; s >= 1; s >>= 1) { const n = s * s * 4; if (o + n > b.length) return undefined; levels.push(b.slice(o, o + n)); o += n }
  return { size, levels }
}

/** sRGB-encoded vector components (how the engine stores colour parameters) to linear. */
const tintToLinear = (t: readonly [number, number, number]): Rgb => [t[0], t[1], t[2]].map((c) => (c >= 1 ? c : srgbToLinear(Math.round(c * 255)))) as unknown as Rgb

export const FALLBACK_COLOR: Rgb = [0.4, 0.4, 0.4]

export const buildPaints = async (o: PaintOptions): Promise<{ provider: ColorProvider; report: PaintReport }> => {
  const t0 = Date.now()
  const conc = o.concurrency ?? 6
  const stems = new Set<string>(), models = new Set<string>()
  for (const n of o.meshNames) {
    const r = refOfMeshName(n)
    if (r?.kind === "agg_prop") models.add(r.model)
    else if (r) stems.add(r.stem)
  }
  mkdirSync(o.workDir, { recursive: true })

  const listFile = join(o.workDir, "pak01-vmats.txt")
  let listing: string
  if (existsSync(listFile)) listing = readFileSync(listFile, "utf8")
  else {
    const r = await run(o.runner, "materials", args.vpkList(o.gameVpk))
    listing = r.stdout.split(/\r?\n/).filter((l) => l.includes(".vmat_c")).join("\n")
    writeFileSync(listFile, listing)
  }
  const vmats = indexVmats(listing)
  const unresolved = new Set<string>()

  // 1. Which material (inner `.vmat_c` path) each stem / prop model uses.
  const stemPath = new Map<string, string>(), modelPath = new Map<string, string>()
  for (const stem of stems) { const p = vmats.get(stem); if (p) stemPath.set(stem, p); else unresolved.add(stem) }
  await pool([...models].sort(), conc, async (model) => {
    const raw = join(o.workDir, "vmdl", `${model}.vmdl_c`), dump = `${raw}.txt`
    try {
      if (!existsSync(dump)) {
        mkdirSync(dirname(raw), { recursive: true })
        if (!existsSync(raw)) await run(o.runner, "materials", args.raw(o.mapVpk, `maps/${o.map}/worldnodes/${model}.vmdl_c`, raw))
        writeFileSync(dump, (await run(o.runner, "materials", args.dumpData(raw))).stdout)
      }
      const p = firstMaterialOfModel(readFileSync(dump, "utf8"))
      if (p) modelPath.set(model, p); else unresolved.add(model)
    } catch (e) {
      unresolved.add(model)
      o.log?.(`materials: model ${model}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  o.log?.(`materials: ${stemPath.size}/${stems.size} material names and ${modelPath.size}/${models.size} prop models resolved to a .vmat_c`)

  // 2. What each material looks like.
  const material = new Map<string, { texture?: string; tint?: Rgb }>()
  const needed = [...new Set([...stemPath.values(), ...modelPath.values()])].sort()
  await pool(needed, conc, async (inner) => {
    const raw = join(o.workDir, "vmat", inner), dump = `${raw}.txt`
    try {
      if (!existsSync(dump)) {
        mkdirSync(dirname(raw), { recursive: true })
        if (!existsSync(raw)) await run(o.runner, "materials", args.raw(o.gameVpk, inner, raw))
        writeFileSync(dump, (await run(o.runner, "materials", args.dumpData(raw))).stdout)
      }
      const info = parseVmatText(readFileSync(dump, "utf8"))
      const tex = baseColorTexture(info), tint = colorTint(info)
      material.set(inner, { ...(tex ? { texture: tex } : {}), ...(tint ? { tint: tintToLinear(tint) } : {}) })
    } catch (e) {
      unresolved.add(inner)
      o.log?.(`materials: ${inner}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  o.log?.(`materials: read ${material.size} of ${needed.length} materials`)

  // 3. Base-colour textures, as small mip chains (cached).
  const textures = new Map<string, MipChain | null>()
  const wanted = [...new Set([...material.values()].flatMap((m) => (m.texture ? [m.texture] : [])))].sort()
  await pool(wanted, conc, async (vtex) => {
    const key = createHash("sha1").update(`${vtex}|${o.maxTexture ?? 128}|alpha-pad-1`).digest("hex").slice(0, 16)
    const cache = join(o.workDir, "mips", `${key}.mip`)
    if (existsSync(cache)) { const m = unpackMips(readFileSync(cache)); if (m) { textures.set(vtex, m); return } }
    const png = join(o.workDir, "tex", `${key}.png`)
    try {
      mkdirSync(dirname(png), { recursive: true }); mkdirSync(dirname(cache), { recursive: true })
      await run(o.runner, "materials", args.file(o.gameVpk, `${vtex}_c`, png))
      const img = decodePng(readFileSync(png))
      const m = buildMips(img.data, img.width, img.height, o.maxTexture ?? 128)
      writeFileSync(cache, packMips(m))
      rmSync(png, { force: true })
      textures.set(vtex, m)
    } catch (e) {
      textures.set(vtex, null)
      o.log?.(`materials: texture ${vtex}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  const paints = new Map<string, MaterialPaint>()
  let textured = 0
  for (const [inner, m] of material) {
    const tex = m.texture ? textures.get(m.texture) ?? undefined : undefined
    if (tex) textured++
    else if (m.texture) unresolved.add(`${inner} (texture ${m.texture})`)
    // A material with neither a readable texture nor a tint has nothing to say: leave it to the fallback.
    if (!tex && !m.tint) continue
    paints.set(inner, { tint: m.tint ?? [1, 1, 1], ...(tex ? { texture: tex } : {}) })
  }
  const provider: ColorProvider = {
    fallback: FALLBACK_COLOR,
    paintFor: (names) => {
      for (const n of names) {
        const r = refOfMeshName(n)
        const inner = r ? (r.kind === "agg_prop" ? modelPath.get(r.model) : stemPath.get(r.stem)) : undefined
        const p = inner ? paints.get(inner) : undefined
        if (p) return p
      }
      return undefined
    }
  }
  const report: PaintReport = {
    stems: stems.size + models.size, resolved: [...stemPath.keys(), ...modelPath.keys()].filter((k) => paints.has((stemPath.get(k) ?? modelPath.get(k))!)).length, textured, textures: [...textures.values()].filter(Boolean).length,
    unresolved: [...unresolved].sort(), seconds: (Date.now() - t0) / 1000
  }
  return { provider, report }
}

/** Mean colour of a paint, for reports. */
export const paintMean = (p: MaterialPaint): Rgb => {
  const t = p.texture ? meanColor(p.texture) : ([1, 1, 1] as Rgb)
  return [t[0] * p.tint[0], t[1] * p.tint[1], t[2] * p.tint[2]]
}
