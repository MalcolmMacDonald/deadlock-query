/**
 * Reads what the colour bake needs out of a material: Source2Viewer's `-b DATA` dump of a `.vmat_c` (KeyValues3 text;
 * `-d` cannot decompile materials of this build). Parameters are lists of `{ m_name = "g_tColor1" m_pValue = resource:"x.vtex" }`
 * style entries, so the parser scans for `m_name` and reads the value that follows it, rather than rely on exact layout.
 */

export interface VmatInfo {
  readonly shader: string | undefined
  /** Texture parameter name to resource path (`.vtex`, as written). */
  readonly textures: Readonly<Record<string, string>>
  /** Vector parameter name to its components. */
  readonly vectors: Readonly<Record<string, ReadonlyArray<number>>>
}

const NUMBERS = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi

export const parseVmatText = (text: string): VmatInfo => {
  const shader = /(?:m_shaderName|shader)\s*=\s*"([^"]+)"/i.exec(text)?.[1]
  const textures: Record<string, string> = {}
  const vectors: Record<string, number[]> = {}
  const chunks = text.split(/\bm_name\s*=\s*/).slice(1)
  for (const c of chunks) {
    const name = /^"([^"]+)"/.exec(c)?.[1]
    if (!name) continue
    // Only look until the next entry: a param entry is one `{ ... }` block.
    const body = c.slice(name.length + 2, c.indexOf("}") < 0 ? undefined : c.indexOf("}"))
    const tex = /(?:m_pValue|m_value|m_texture)\s*=\s*(?:resource(?:_name)?:)?\s*"([^"]*\.vtex)"/i.exec(body)?.[1]
    if (tex !== undefined) { textures[name] ??= tex; continue }
    const vec = /m_value\s*=\s*\[([^\]]*)\]/i.exec(body)?.[1]
    if (vec !== undefined) { const v = vec.match(NUMBERS)?.map(Number) ?? []; if (v.length >= 3) vectors[name] ??= v }
  }
  return { shader, textures, vectors }
}

/** Texture parameters that can carry the base colour, in preference order. */
const BASE_COLOR_PARAMS = ["g_tColor", "g_tColor1", "g_tColor2", "g_tColor0", "g_tAlbedo"]

/**
 * The base-colour texture of a material: the first colour parameter whose file is not a mask or a default placeholder
 * (`environment_blend` materials often keep a mask in `g_tColor1` and the colour map in `g_tColor2`).
 */
export const baseColorTexture = (m: VmatInfo): string | undefined => {
  const names = [...BASE_COLOR_PARAMS.filter((n) => m.textures[n]), ...Object.keys(m.textures).filter((n) => /^g_tcolor/i.test(n) && !BASE_COLOR_PARAMS.includes(n))]
  for (const n of names) {
    const p = m.textures[n]!
    const file = p.slice(p.lastIndexOf("/") + 1).toLowerCase()
    if (/mask|default_|_normal|_rough|_metal|_ao\b/.test(file)) continue
    return p
  }
  return undefined
}

/** `g_vColorTint` when the material sets one (rgb in 0..1); other tints (blend layers, contrast / saturation) are not applied. */
export const colorTint = (m: VmatInfo): readonly [number, number, number] | undefined => {
  const v = m.vectors["g_vColorTint"]
  if (!v || v.slice(0, 3).some((x) => !(x >= 0 && x <= 4))) return undefined
  return [v[0]!, v[1]!, v[2]!]
}
