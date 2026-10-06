import type { Entity } from "@deadlock-query/contracts"
import { entityKind } from "./entityKinds.ts"

export type VentValue = string | number | boolean | number[] | string[]
export interface RawEntity {
  readonly index: number
  readonly props: Record<string, VentValue>
  readonly outputs: string[]
}

const NUM = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i

/** Parse one value: `"str"`, `[ x, y, z ]`, `resource_name:"..."`, number, or bare word. */
export const parseVentValue = (raw: string): VentValue => {
  const v = raw.trim()
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1)
  if (v.startsWith("[") && v.endsWith("]")) {
    const parts = v.slice(1, -1).split(",").map((s) => s.trim()).filter((s) => s !== "")
    const nums = parts.map(Number)
    return nums.every(Number.isFinite) ? nums : parts
  }
  const res = /^resource_name:"(.*)"$/.exec(v)
  if (res) return res[1]!
  if (v === "true") return true
  if (v === "false") return false
  return NUM.test(v) ? Number(v) : v
}

/** Parse the text export of a `.vents_c` lump: `====N====` separators, `key  value` lines, `@Output ...` lines. */
export const parseVents = (text: string): RawEntity[] => {
  const out: RawEntity[] = []
  let cur: RawEntity | undefined
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t === "") continue
    const sep = /^=+\s*(\d+)\s*=+$/.exec(t)
    if (sep) {
      cur = { index: Number(sep[1]), props: {}, outputs: [] }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (t.startsWith("@")) { cur.outputs.push(t); continue }
    const m = /^(\S+)\s+(.*)$/.exec(t)
    if (m) cur.props[m[1]!] = parseVentValue(m[2]!)
  }
  return out
}

const vec3 = (v: VentValue | undefined): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number") ? [v[0] as number, v[1] as number, v[2] as number] : undefined
const num = (v: VentValue | undefined): number | undefined => (typeof v === "number" ? v : undefined)

/** Map raw entities to contract entities. Unknown classes are kept without `kind`; ids are unique. */
export const toEntities = (raw: ReadonlyArray<RawEntity>): Entity[] => {
  const seen = new Set<string>()
  return raw.flatMap((r) => {
    const cls = r.props["classname"]
    if (typeof cls !== "string") return []
    const hid = r.props["hammeruniqueid"]
    let id = typeof hid === "string" || typeof hid === "number" ? String(hid) : `e${r.index}`
    if (seen.has(id)) id = `${id}#${r.index}`
    seen.add(id)
    const { classname: _c, origin, angles, teamnumber, lanenum, ...rest } = r.props
    const properties: Record<string, unknown> = { ...rest }
    if (r.outputs.length) properties["outputs"] = r.outputs
    const kind = entityKind(cls, typeof rest["subclass_name"] === "string" ? rest["subclass_name"] : undefined)
    const rot = vec3(angles)
    const team = num(teamnumber)
    const lane = num(lanenum)
    return [{
      id, class: cls,
      ...(kind ? { kind } : {}),
      position: vec3(origin) ?? [0, 0, 0],
      ...(rot ? { rotation: rot } : {}),
      ...(team !== undefined ? { team } : {}),
      ...(lane !== undefined ? { lane } : {}),
      properties
    } as Entity]
  })
}
