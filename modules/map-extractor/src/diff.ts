import { readFileSync } from "node:fs"
import { join } from "node:path"

/** One line of a bundle comparison: `before` and `after` are undefined when the thing exists on one side only. */
export interface DiffLine { readonly what: string; readonly before: unknown; readonly after: unknown }
export interface BundleDiff { readonly same: boolean; readonly lines: DiffLine[] }

type Json = Record<string, any>
const readJson = (dir: string, f: string): Json => JSON.parse(readFileSync(join(dir, f), "utf8"))

const countBy = <T>(xs: ReadonlyArray<T>, key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1
  return out
}

/** Flat, comparable facts of a bundle: build, tiles, entities by kind and team, baked products. Reads JSON only. */
export const bundleFacts = (dir: string): Record<string, unknown> => {
  const m = readJson(dir, "manifest.json")
  const facts: Record<string, unknown> = {}
  facts["gameBuildId"] = m["gameBuildId"]
  facts["mapName"] = m["mapName"]
  facts["tier"] = m["tier"]
  const tiles: Json[] = m["tiles"] ?? []
  const lod0 = tiles.filter((t) => t["lod"] === undefined && !/#lod\d+$/.test(t["id"]))
  facts["tiles"] = lod0.length
  facts["lodTiles"] = tiles.length - lod0.length
  facts["tileBytes"] = tiles.reduce((s, t) => s + (t["bytes"] ?? 0), 0)
  facts["collisionFile"] = m["collision"]?.["file"]
  const ents: Json[] = readJson(dir, m["entitiesFile"] ?? "entities.json")["entities"] ?? []
  facts["entities"] = ents.length
  for (const [k, n] of Object.entries(countBy(ents, (e) => e["kind"] ?? `class:${e["class"]}`))) facts[`entities.${k}`] = n
  for (const [k, n] of Object.entries(countBy(ents.filter((e) => e["team"] !== undefined), (e) => String(e["team"])))) facts[`team.${k}`] = n
  const baked: Json | undefined = m["baked"]
  if (baked) {
    facts["baked.version"] = baked["bakeVersion"]
    facts["baked.floorSource"] = baked["floorSource"]
    facts["baked.interiorSource"] = baked["interiorSource"]
    facts["baked.channels"] = baked["sampleGrid"]?.["channels"]
    facts["baked.sampleGridBytes"] = baked["sampleGrid"]?.["bytes"]
    const nav: Json | undefined = baked["navmesh"]
    if (nav) {
      facts["nav.version"] = nav["bakeVersion"]
      facts["nav.polygons"] = nav["polygons"]
      facts["nav.components"] = nav["componentsWithLinks"] ?? nav["components"]
      facts["nav.largestShare"] = nav["largestComponentShareWithLinks"] ?? nav["largestComponentShare"]
      for (const [k, n] of Object.entries<number>(nav["links"]?.["byKind"] ?? {})) facts[`nav.links.${k}`] = n
    }
  }
  return facts
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What changed between two bundles (for example the same map on two game builds): every fact that differs, sorted by name. */
export const diffBundles = (before: string, after: string): BundleDiff => {
  const a = bundleFacts(before), b = bundleFacts(after)
  const lines: DiffLine[] = []
  for (const what of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!same(a[what], b[what])) lines.push({ what, before: a[what], after: b[what] })
  }
  return { same: lines.length === 0, lines }
}

export const formatDiff = (d: BundleDiff): string =>
  d.same ? "bundles match" : d.lines.map((l) => `${l.what}: ${l.before === undefined ? "-" : JSON.stringify(l.before)} -> ${l.after === undefined ? "-" : JSON.stringify(l.after)}`).join("\n")
