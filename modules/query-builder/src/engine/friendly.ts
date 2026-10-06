import type { QueryDiagnostic } from "@deadlock-query/contracts"
import type { DocIndex } from "../docs/catalog.ts"

/** Rewrites of raw TypeScript / runtime errors into advice for people who write queries, not TS. */
export interface Friendly {
  /** Same position and severity; the message leads with advice and keeps the original in parentheses. */
  readonly diagnostic: (d: QueryDiagnostic) => QueryDiagnostic
  /** Extra warnings found by looking at the source text (checked alongside the type-checker). */
  readonly lint: (source: string) => ReadonlyArray<QueryDiagnostic>
  readonly runtime: (message: string) => string
}

/** Methods people reach for from `Array`/Lodash that the LINQ-style `Seq` spells differently. */
export const ARRAY_TO_SEQ: Readonly<Record<string, string>> = {
  filter: "where(predicate)",
  map: "select(fn)",
  flatMap: "selectMany(fn)",
  length: "count()",
  find: "first(predicate)",
  some: "any(predicate)",
  every: "all(predicate)",
  sort: "orderBy(key)",
  slice: "take(n) / skip(n)",
  reduce: "sum(fn), min(fn) or max(fn)",
  forEach: "select(fn).toArray()",
}

const SEQ_FAMILY = /^(Seq|OrderedSeq|EntityList)\b/

const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]!
}

/** Closest candidate within a typo or two (never for very short names, where everything is "close"). */
const nearest = (word: string, candidates: Iterable<string>): string | undefined => {
  let best: string | undefined
  let bestD = Math.max(1, Math.min(2, Math.floor(word.length / 3)))
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase())
    if (d <= bestD) { best = c; bestD = d }
  }
  return best
}

export const makeFriendly = (index: DocIndex): Friendly => {
  const topLevel = new Set(index.items.filter((i) => i.owner === undefined && i.kind !== "type" && i.kind !== "interface").map((i) => i.name))
  const membersOf = (type: string): string[] => {
    const own = index.items.filter((i) => i.owner === type).map((i) => i.name)
    return SEQ_FAMILY.test(type) ? [...new Set([...own, ...index.items.filter((i) => i.owner === "Seq").map((i) => i.name)])] : own
  }

  const advice = (message: string): string | undefined => {
    let m = /Cannot find name '([^']+)'/.exec(message)
    if (m) {
      const name = m[1]!
      const owners = index.byName.get(name)?.filter((i) => i.owner === "MapContext")
      if (owners?.length) return `\`${name}\` is not a global; the map's data lives on \`map\`. Did you mean \`map.${name}\`?`
      const close = nearest(name, [...topLevel, "map"])
      return close ? `Unknown name \`${name}\`. Did you mean \`${close}\`?` : `Unknown name \`${name}\`. Open the Docs panel to see what is available.`
    }
    m = /Property '([^']+)' does not exist on type '([^']+)'/.exec(message)
    if (m) {
      const [, prop, type] = m as unknown as [string, string, string]
      const base = type.replace(/<.*$/, "")
      if (SEQ_FAMILY.test(base) && ARRAY_TO_SEQ[prop]) return `Sequences are LINQ-style, so there is no \`.${prop}\`; use \`.${ARRAY_TO_SEQ[prop]}\`.`
      const close = nearest(prop, membersOf(base))
      if (close) return `\`${base}\` has no \`${prop}\`. Did you mean \`${close}\`?`
      if (index.items.some((i) => i.owner === base)) return `\`${base}\` has no \`${prop}\`. Open the Docs panel to see its members.`
      return undefined
    }
    if (/A 'return' statement can only be used within a function body/.test(message)) return "A query is one expression (or statements ending in one): the last expression is the result, so drop `return`."
    if (/top-level 'await'|'await' expressions are only allowed/.test(message)) return "Queries run synchronously; there is no `await` at the top level."
    m = /Argument of type '([^']*)' is not assignable to parameter of type '([^']*)'/.exec(message)
    if (m) {
      const param = m[2]!
      if (/\bLane\b/.test(param)) return 'Lanes are "yellow", "blue" or "purple" (or 1, 2, 3).'
      if (/\bLocatable\b|\bVec3\b/.test(param)) return "Expected a position: an entity (e.g. a guardian), `vec(x, y, z)` or a `.position`."
    }
    return undefined
  }

  const LITERAL_DURATION = /\bwithinTravelTime\(\s*(\d+(?:\.\d+)?)\s*,/g
  return {
    diagnostic: (d) => {
      const a = advice(d.message)
      return a ? { ...d, message: `${a} (${d.message})` } : d
    },
    lint: (source) => {
      const out: QueryDiagnostic[] = []
      for (const m of source.matchAll(LITERAL_DURATION)) {
        const before = source.slice(0, m.index! + m[0].indexOf(m[1]!))
        const line = before.split("\n").length
        out.push({ message: `Durations read better with a unit helper: write \`seconds(${m[1]})\`.`, line, column: before.length - before.lastIndexOf("\n"), severity: "warning" })
      }
      return out
    },
    runtime: (message) => {
      const needs = /^([\w.]+\(\)) needs (?:a navmesh|a spatial backend|semantics)/.exec(message)
      if (needs) return `${message}\n${needs[1]} needs map data this bundle does not have yet (navigation mesh, collision geometry or semantics), so it cannot run here. Queries that only use positions and straight-line distances still work.`
      if (/Cannot read propert(?:y|ies) of (?:undefined|null)/.test(message)) return `${message}\nSomething was missing here: \`closest()\` and \`first()\` return \`undefined\` when the list is empty, so guard with \`?.\` or filter first.`
      return message
    },
  }
}
