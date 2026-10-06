import { MetadataRecord, ringArea, type MetadataKind, type Vec3 } from "@deadlock-query/contracts"
import type { Schema } from "effect"
import { DEFAULT_MAX_AREA, DEFAULT_SURFACE_EPSILON, type ValidationContext } from "./context.ts"
import { firstRepeatedVertex, firstSelfIntersection } from "./geometry.ts"
import { issue, type Issue } from "./issues.ts"

export type RecordOf<K extends MetadataKind> = Extract<MetadataRecord, { readonly kind: K }>

/** Checks one record on its own; cross-record rules (duplicates, overlaps) live in `validate.ts`. */
export type RecordValidator<R extends MetadataRecord = MetadataRecord> = (record: R, ctx: ValidationContext) => ReadonlyArray<Issue>

export type GeometryType = "polygon" | "point" | "link" | "custom"

/** How the editor draws the kind: data only, M1 turns it into a viewer `ExternalTool`. */
export interface ToolDefinition {
  readonly id: string
  readonly label: string
  readonly hint: string
  /** Clicks needed: a ring or polyline takes any number and ends with Finish. */
  readonly clicks: number | "many"
}

export interface KindStyle {
  /** CSS colour of accepted records; proposed, rejected and stale variants are derived from it by the overlay code. */
  readonly color: string
  readonly glyph: string
}

export interface KindDefinition<K extends MetadataKind = MetadataKind> {
  readonly id: K
  readonly label: string
  readonly geometryType: GeometryType
  /** The record's Effect Schema, taken from the contracts union so there is one source of truth. */
  readonly schema: Schema.Codec<RecordOf<K>>
  readonly validators: ReadonlyArray<RecordValidator<RecordOf<K>>>
  readonly tool: ToolDefinition
  readonly style: KindStyle
  /** Two accepted or proposed records of this kind closer than `radius` (world units) are duplicates. Absent = no rule. */
  readonly uniqueness?: { readonly radius: number }
}

// --- shared validators -------------------------------------------------------------------------------------------

const ringOf = (r: MetadataRecord): ReadonlyArray<Vec3> | undefined =>
  r.kind === "walkableRegion" ? r.ring : r.kind === "custom" && r.geometry.type === "polygon" ? r.geometry.ring : undefined

/** Polygon rules: no repeated vertices, no self-intersection, area within limits. */
export const polygonValidator: RecordValidator = (r, ctx) => {
  const ring = ringOf(r)
  if (!ring) return []
  const out: Issue[] = []
  const rep = firstRepeatedVertex(ring)
  if (rep !== undefined) out.push(issue("error", "polygon-repeated-vertex", `${r.kind} "${r.id}": vertices ${rep} and ${(rep + 1) % ring.length} are the same point`, { recordId: r.id, at: ring[rep]! }))
  const hit = firstSelfIntersection(ring)
  if (hit !== undefined && rep === undefined) out.push(issue("error", "polygon-self-intersects", `${r.kind} "${r.id}": edges ${hit[0]} and ${hit[1]} touch or cross`, { recordId: r.id, at: ring[hit[0]]! }))
  const area = ringArea(ring)
  const max = ctx.maxArea ?? (ctx.bounds
    ? (ctx.bounds.max[0] - ctx.bounds.min[0]) * (ctx.bounds.max[1] - ctx.bounds.min[1])
    : DEFAULT_MAX_AREA)
  if (area > max) out.push(issue("error", "polygon-too-large", `${r.kind} "${r.id}": area ${Math.round(area)} exceeds the limit ${Math.round(max)}`, { recordId: r.id, at: ring[0]! }))
  return out
}

const surfaceIssue = (r: MetadataRecord, label: string, p: Vec3, ctx: ValidationContext): Issue | undefined => {
  if (!ctx.collision) return undefined
  const eps = ctx.surfaceEpsilon ?? DEFAULT_SURFACE_EPSILON
  const ground = ctx.collision.groundZ(p[0], p[1], p[2] + eps)
  if (ground === undefined) return issue("error", "no-surface", `${r.kind} "${r.id}": ${label} has no surface below it`, { recordId: r.id, at: p })
  if (Math.abs(p[2] - ground) > eps) return issue("error", "not-on-surface", `${r.kind} "${r.id}": ${label} is ${Math.round(Math.abs(p[2] - ground))} units off the surface (limit ${eps})`, { recordId: r.id, at: p })
  return undefined
}

/** A point kind's position sits on a surface (within epsilon) and not inside solid. Skipped without a collision probe. */
export const pointOnSurfaceValidator: RecordValidator = (r, ctx) => {
  if (!ctx.collision) return []
  const p = r.kind === "creepCamp" || r.kind === "sinnersSacrifice" || r.kind === "healingOrb" ? r.position
    : r.kind === "custom" && r.geometry.type === "point" ? r.geometry.at : undefined
  if (!p) return []
  if (ctx.collision.insideSolid(p)) return [issue("error", "inside-solid", `${r.kind} "${r.id}": position is inside solid geometry`, { recordId: r.id, at: p })]
  const s = surfaceIssue(r, "position", p, ctx)
  return s ? [s] : []
}

/** Both ends of a nav link stand on a surface. Skipped without a collision probe. */
export const linkEndpointsValidator: RecordValidator = (r, ctx) => {
  if (r.kind !== "navLink" || !ctx.collision) return []
  const out: Issue[] = []
  for (const [label, p] of [["from", r.from], ["to", r.to]] as const) {
    if (ctx.collision.insideSolid(p)) out.push(issue("error", "inside-solid", `navLink "${r.id}": ${label} end is inside solid geometry`, { recordId: r.id, at: p }))
    else { const s = surfaceIssue(r, `${label} end`, p, ctx); if (s) out.push(s) }
  }
  return out
}

// --- registry ----------------------------------------------------------------------------------------------------

const schemaFor = <K extends MetadataKind>(kind: K): Schema.Codec<RecordOf<K>> => {
  const member = MetadataRecord.members.find((m) => m.fields.kind.literal === kind)
  if (!member) throw new Error(`contracts has no record schema for kind "${kind}"`)
  return member as unknown as Schema.Codec<RecordOf<K>>
}

const define = <K extends MetadataKind>(def: Omit<KindDefinition<K>, "schema"> ): KindDefinition<K> => ({ ...def, schema: schemaFor(def.id) })

/**
 * Every kind of map metadata. A new kind is a single entry here plus its record in contracts: schema, validators, tool,
 * style and uniqueness rule travel together, and the CLI, editor and review panels all read this table.
 * Radii are defaults in world units (Source units, 1 unit = 1/16 ft) and are meant to be tuned on the real map.
 */
export const KINDS = {
  walkableRegion: define({
    id: "walkableRegion", label: "Walkable region", geometryType: "polygon",
    validators: [polygonValidator],
    tool: { id: "metadata.walkableRegion", label: "Walkable region", hint: "Click each corner on the ground, Enter to close", clicks: "many" },
    style: { color: "#2fbf71", glyph: "▱" }
  }),
  creepCamp: define({
    id: "creepCamp", label: "Creep camp", geometryType: "point",
    validators: [pointOnSurfaceValidator],
    tool: { id: "metadata.creepCamp", label: "Creep camp", hint: "Click the camp centre", clicks: 1 },
    style: { color: "#e0a030", glyph: "●" },
    uniqueness: { radius: 200 }
  }),
  sinnersSacrifice: define({
    id: "sinnersSacrifice", label: "Sinner's Sacrifice", geometryType: "point",
    validators: [pointOnSurfaceValidator],
    tool: { id: "metadata.sinnersSacrifice", label: "Sinner's Sacrifice", hint: "Click the sacrifice location", clicks: 1 },
    style: { color: "#c04060", glyph: "✦" },
    uniqueness: { radius: 200 }
  }),
  healingOrb: define({
    id: "healingOrb", label: "Healing orb", geometryType: "point",
    validators: [pointOnSurfaceValidator],
    tool: { id: "metadata.healingOrb", label: "Healing orb", hint: "Click the orb spawn", clicks: 1 },
    style: { color: "#40b0e0", glyph: "+" },
    uniqueness: { radius: 100 }
  }),
  navLink: define({
    id: "navLink", label: "Navigation link", geometryType: "link",
    validators: [linkEndpointsValidator],
    tool: { id: "metadata.navLink", label: "Navigation link", hint: "Click the start, then the end", clicks: 2 },
    style: { color: "#a070e0", glyph: "↔" }
  }),
  custom: define({
    id: "custom", label: "Custom", geometryType: "custom",
    validators: [polygonValidator, pointOnSurfaceValidator],
    tool: { id: "metadata.custom", label: "Custom feature", hint: "Pick a shape, then click its points", clicks: "many" },
    style: { color: "#909090", glyph: "◆" }
  })
} as const satisfies { readonly [K in MetadataKind]: KindDefinition<K> }

export const KIND_IDS = Object.keys(KINDS) as ReadonlyArray<MetadataKind>
export const isMetadataKind = (s: string): s is MetadataKind => Object.hasOwn(KINDS, s)
export const kindDefinition = (kind: MetadataKind): KindDefinition => KINDS[kind] as unknown as KindDefinition

