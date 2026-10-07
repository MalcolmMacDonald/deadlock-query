import type { Entity } from "@deadlock-query/contracts"
import { entityKind } from "./entityKinds.ts"
import { laneNumberFromProperties, ziplineLanes } from "./lanes.ts"

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

/** A value that opens a quote it does not close on the same line (`pathnodes "`): the rest is on the following lines. */
const opensQuote = (v: string): boolean => v.startsWith('"') && !(v.length >= 2 && v.endsWith('"') && v !== '"""')

const NUMBER_LIST = /^[\s,\[\]]*(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?[\s,\[\]]*)*$/i

/** Body of a multi-line quoted value: all-numbers text (`pathnodes`) becomes a flat number list, anything else stays text. */
const multiLineValue = (body: string): VentValue =>
  NUMBER_LIST.test(body) ? body.split(/[\s,\[\]]+/).filter((t) => t !== "").map(Number) : body

/**
 * Parse the text export of a `.vents_c` lump: `====N====` separators, `key  value` lines, `@Output ...` lines. A quoted
 * value may continue over several lines up to the line that closes the quote (`lane_marker_path` and
 * `citadel_zipline_path` `pathnodes`); those used to be split into one junk property per line (`"0.0,"`).
 */
export const parseVents = (text: string): RawEntity[] => {
  const out: RawEntity[] = []
  let cur: RawEntity | undefined
  let open: { key: string; lines: string[]; triple: boolean } | undefined
  const close = (): void => {
    if (cur && open) cur.props[open.key] = multiLineValue(open.lines.join(" "))
    open = undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    const sep = /^=+\s*(\d+)\s*=+$/.exec(t)
    if (open) {
      if (!sep) {
        // A `"""` block (the real `pathnodes`) ends at the line carrying the closing `"""`.
        const q = open.triple ? '"""' : '"'
        const ends = t.endsWith(q)
        open.lines.push(ends ? t.slice(0, -q.length) : t)
        if (ends) close()
        continue
      }
      close() // an unterminated quote ends with its entity rather than swallowing the next one
    }
    if (t === "") continue
    if (sep) {
      cur = { index: Number(sep[1]), props: {}, outputs: [] }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (t.startsWith("@")) { cur.outputs.push(t); continue }
    const m = /^(\S+)\s+(.*)$/.exec(t)
    if (!m) continue
    const v = m[2]!.trim()
    if (opensQuote(v)) { const triple = v.startsWith('"""'); open = { key: m[1]!, lines: [v.slice(triple ? 3 : 1)], triple } }
    else cur.props[m[1]!] = parseVentValue(m[2]!)
  }
  close()
  return out
}

const vec3 = (v: VentValue | undefined): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number") ? [v[0] as number, v[1] as number, v[2] as number] : undefined
const num = (v: VentValue | undefined): number | undefined => (typeof v === "number" ? v : undefined)

/**
 * Map raw entities to contract entities. Unknown classes are kept without `kind`; ids are unique. `lane` (1 Yellow,
 * 2 Blue, 3 Green) is the entity's own `lanenum` when it has one, else the colour in a guardian/walker/barracks name or
 * a zipline path's tint (see `lanes.ts`).
 */
export const toEntities = (raw: ReadonlyArray<RawEntity>): Entity[] => {
  const seen = new Set<string>()
  const entities = raw.flatMap((r) => {
    const cls = r.props["classname"]
    if (typeof cls !== "string") return []
    const hid = r.props["hammeruniqueid"]
    let id = typeof hid === "string" || typeof hid === "number" ? String(hid) : `e${r.index}`
    if (seen.has(id)) id = `${id}#${r.index}`
    seen.add(id)
    const { classname: _c, origin, angles, teamnumber, lanenum, ...rest } = r.props
    const properties: Record<string, unknown> = { ...rest }
    if (r.outputs.length) properties["outputs"] = r.outputs
    // Guardians carry their marker in `bossname` (build 25738777); older exports and other classes use `subclass_name`.
    const sub = [rest["subclass_name"], rest["bossname"]].find((v): v is string => typeof v === "string" && v !== "")
    const kind = entityKind(cls, sub)
    const rot = vec3(angles)
    const team = num(teamnumber)
    const lane = num(lanenum) ?? laneNumberFromProperties(kind, properties)
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
  const zipLane = ziplineLanes(entities)
  return entities.map((e) => (e.lane === undefined && zipLane.has(e.id) ? { ...e, lane: zipLane.get(e.id)! } : e))
}
