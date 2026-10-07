import { Schema } from "effect"
import { SCHEMA_VERSION, Vec3S, type Manifest } from "./MapBundle.ts"
import type { Vec3 } from "./Space.ts"
import { sha256Hex } from "./fixtures/sha256.ts"

/**
 * User-submitted map metadata: facts the extractor cannot derive (creep camps, Sinner's Sacrifice, healing-orb spawns)
 * and overrides to the auto-generated navmesh (walkable / no-go regions, extra links). Geometry is world space,
 * Source units, Z-up, like entities and annotations. Strings are plain text: nothing here is ever rendered as markup.
 */

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
/** ISO 8601 timestamp, e.g. `2026-10-06T12:00:00Z`. */
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/))
const PositiveNumber = Schema.Finite.check(Schema.isGreaterThan(0))

/** proposed -> accepted | rejected; accepted -> stale when a new game build no longer fits it. */
export const MetadataStatus = Schema.Literals(["proposed", "accepted", "rejected", "stale"])
export type MetadataStatus = typeof MetadataStatus.Type

/** Self-declared and unverified: there are no user accounts. */
export const Submitter = Schema.Struct({
  name: Text(80).check(Schema.isMinLength(1)),
  github: Schema.optionalKey(Text(39))
})
export type Submitter = typeof Submitter.Type

/** Where a record came from and who decided on it. Kept on every record so query results can show provenance. */
export const Provenance = Schema.Struct({
  submitter: Schema.optionalKey(Submitter),
  submissionId: Schema.optionalKey(Id),
  submittedAt: Schema.optionalKey(Timestamp),
  reviewer: Schema.optionalKey(Text(80)),
  reviewedAt: Schema.optionalKey(Timestamp),
  /** Reviewer's reason, shown next to a rejected or stale record. */
  comment: Schema.optionalKey(Text(1000))
})
export type Provenance = typeof Provenance.Type

const common = {
  id: Id,
  status: MetadataStatus,
  provenance: Provenance,
  name: Schema.optionalKey(Text(120)),
  note: Schema.optionalKey(Text(1000))
}

const Ring = Schema.Array(Vec3S).check(Schema.isMinLength(3), Schema.isMaxLength(512))

/** Region flags: `noGo` blocks navigation, `walkable` adds or corrects ground, `interior`/`water` tag the surface. */
export const RegionFlag = Schema.Literals(["walkable", "noGo", "interior", "water"])
export type RegionFlag = typeof RegionFlag.Type

export const NavLinkKind = Schema.Literals(["zipline", "jumpPad", "climb", "mantle", "teleport", "custom"])
export type NavLinkKind = typeof NavLinkKind.Type

const CustomGeometry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("point"), at: Vec3S }),
  Schema.Struct({ type: Schema.Literal("polyline"), points: Schema.Array(Vec3S).check(Schema.isMinLength(2), Schema.isMaxLength(512)) }),
  Schema.Struct({ type: Schema.Literal("polygon"), ring: Ring })
])

export const MetadataRecord = Schema.Union([
  /** Polygon on the ground with a floor height and a flag. Overrides apply at query-load time, not by re-baking. */
  Schema.Struct({
    ...common, kind: Schema.Literal("walkableRegion"),
    ring: Ring, floorZ: Schema.Finite, flag: RegionFlag,
    /** Area cost multiplier for pathfinding (> 0); absent = 1. */
    costMultiplier: Schema.optionalKey(PositiveNumber)
  }),
  Schema.Struct({
    ...common, kind: Schema.Literal("creepCamp"),
    position: Vec3S, tier: Schema.optionalKey(Schema.Literals(["weak", "medium", "strong"]))
  }),
  Schema.Struct({ ...common, kind: Schema.Literal("sinnersSacrifice"), position: Vec3S }),
  Schema.Struct({
    ...common, kind: Schema.Literal("healingOrb"),
    position: Vec3S, respawnSeconds: Schema.optionalKey(PositiveNumber)
  }),
  /** Extra navigation link the navmesh cannot derive (a zipline, a jump pad). */
  Schema.Struct({
    ...common, kind: Schema.Literal("navLink"),
    from: Vec3S, to: Vec3S, linkKind: NavLinkKind, bidirectional: Schema.Boolean,
    cost: Schema.optionalKey(PositiveNumber)
  }),
  Schema.Struct({
    ...common, kind: Schema.Literal("custom"),
    /** Free-form kind label, e.g. `trap` or `door`. */
    label: Text(60).check(Schema.isMinLength(1)),
    geometry: CustomGeometry,
    properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Text(200), Schema.Finite, Schema.Boolean])))
  })
])
export type MetadataRecord = typeof MetadataRecord.Type
export type MetadataKind = MetadataRecord["kind"]

/** One file per kind in `data/metadata/<gameBuildId>/<kind>.json`. */
export const MetadataFile = Schema.Struct({
  schemaVersion: Schema.String,
  gameBuildId: Schema.String,
  mapName: Schema.String,
  records: Schema.Array(MetadataRecord)
})
export type MetadataFile = typeof MetadataFile.Type

/** The merged `metadata.bundle.json` the viewer and the query library load. `contentHash` covers build, map and records. */
export const MetadataBundle = Schema.Struct({
  schemaVersion: Schema.String,
  gameBuildId: Schema.String,
  mapName: Schema.String,
  /** sha256 hex of the canonical JSON of `{ gameBuildId, mapName, records }`; see `metadataContentHash`. */
  contentHash: Schema.String,
  records: Schema.Array(MetadataRecord)
})
export type MetadataBundle = typeof MetadataBundle.Type

/** What a contributor sends (`POST /submit`, or the downloaded fallback file). Every record is `proposed`. */
export const Submission = Schema.Struct({
  schemaVersion: Schema.String,
  id: Id,
  gameBuildId: Schema.String,
  mapName: Schema.String,
  createdAt: Timestamp,
  submitter: Submitter,
  note: Schema.optionalKey(Text(1000)),
  records: Schema.Array(MetadataRecord).check(Schema.isMinLength(1), Schema.isMaxLength(500))
})
export type Submission = typeof Submission.Type

export const ReviewVerdict = Schema.Literals(["accepted", "rejected", "changesRequested"])
export type ReviewVerdict = typeof ReviewVerdict.Type

export const ReviewDecision = Schema.Struct({
  submissionId: Id,
  recordId: Id,
  decision: ReviewVerdict,
  reviewer: Text(80).check(Schema.isMinLength(1)),
  decidedAt: Timestamp,
  comment: Schema.optionalKey(Text(1000))
})
export type ReviewDecision = typeof ReviewDecision.Type

/** JSON with object keys sorted at every level, so equal data always serialises to equal text. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v)

const byKindThenId = (a: MetadataRecord, b: MetadataRecord) =>
  a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1

export const metadataContentHash = (b: Pick<MetadataBundle, "gameBuildId" | "mapName" | "records">): string =>
  sha256Hex(new TextEncoder().encode(canonicalJson({ gameBuildId: b.gameBuildId, mapName: b.mapName, records: b.records })))

/** Deterministic bundle: records ordered by kind then id, hash filled in. Input order never changes the output. */
export const makeMetadataBundle = (
  meta: { readonly gameBuildId: string; readonly mapName: string },
  records: ReadonlyArray<MetadataRecord>
): MetadataBundle => {
  const sorted = [...records].sort(byKindThenId)
  return { schemaVersion: SCHEMA_VERSION, ...meta, contentHash: metadataContentHash({ ...meta, records: sorted }), records: sorted }
}

/** True when `contentHash` matches the records: detects hand edits and truncated downloads. */
export const verifyMetadataBundle = (b: MetadataBundle): boolean => b.contentHash === metadataContentHash(b)

/** Records the query library and viewer should use: accepted only (proposed, rejected and stale are not facts). */
export const acceptedRecords = (b: Pick<MetadataBundle, "records">): ReadonlyArray<MetadataRecord> =>
  b.records.filter((r) => r.status === "accepted")

const points = (r: MetadataRecord): ReadonlyArray<Vec3> => {
  switch (r.kind) {
    case "walkableRegion": return r.ring
    case "creepCamp": case "sinnersSacrifice": case "healingOrb": return [r.position]
    case "navLink": return [r.from, r.to]
    case "custom": return r.geometry.type === "point" ? [r.geometry.at] : r.geometry.type === "polyline" ? r.geometry.points : r.geometry.ring
  }
}

/** Area of a ring projected on the ground plane (shoelace), in square world units. */
export const ringArea = (ring: ReadonlyArray<Vec3>): number => {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    s += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(s) / 2
}

export interface MetadataValidationOptions {
  /** Map bounds (`manifest.bounds`): every point must lie inside, with `boundsMargin` slack. */
  readonly bounds?: Manifest["bounds"]
  readonly boundsMargin?: number
  /** Smallest polygon area accepted (default 1 square unit: rejects degenerate rings). */
  readonly minArea?: number
}

/**
 * Cross-field rules the schema cannot express: unique ids, non-degenerate polygons, points inside the map bounds,
 * a link that goes somewhere. Geometry tests against collision (point inside solid, duplicates near an existing camp)
 * need the loaded bundle and live with the validators in map-metadata.
 */
export const validateMetadataRecords = (
  records: ReadonlyArray<MetadataRecord>, opts: MetadataValidationOptions = {}
): ReadonlyArray<string> => {
  const errors: string[] = []
  const ids = new Set<string>()
  const margin = opts.boundsMargin ?? 0
  const minArea = opts.minArea ?? 1
  for (const r of records) {
    if (ids.has(r.id)) errors.push(`duplicate record id "${r.id}"`)
    ids.add(r.id)
    const ring = r.kind === "walkableRegion" ? r.ring : r.kind === "custom" && r.geometry.type === "polygon" ? r.geometry.ring : undefined
    if (ring && ringArea(ring) < minArea) errors.push(`${r.kind} "${r.id}": polygon has no area`)
    if (r.kind === "navLink" && r.from.every((v, i) => v === r.to[i])) errors.push(`navLink "${r.id}": from and to are the same point`)
    if (opts.bounds) {
      const { min, max } = opts.bounds
      const outside = points(r).some((p) => p.some((v, i) => v < min[i]! - margin || v > max[i]! + margin))
      if (outside) errors.push(`${r.kind} "${r.id}": a point lies outside the map bounds`)
    }
  }
  return errors
}

/** Cross-field rules for a submission: records are proposed and unique, build/map match the loaded bundle if given. */
export const validateSubmission = (
  s: Submission, expect: { readonly gameBuildId?: string; readonly mapName?: string; readonly bounds?: Manifest["bounds"] } = {}
): ReadonlyArray<string> => {
  const errors: string[] = []
  if (expect.gameBuildId !== undefined && s.gameBuildId !== expect.gameBuildId) errors.push(`gameBuildId "${s.gameBuildId}" is not the loaded build "${expect.gameBuildId}"`)
  if (expect.mapName !== undefined && s.mapName !== expect.mapName) errors.push(`mapName "${s.mapName}" is not the loaded map "${expect.mapName}"`)
  for (const r of s.records) if (r.status !== "proposed") errors.push(`record "${r.id}" has status "${r.status}": a submission may only contain proposed records`)
  errors.push(...validateMetadataRecords(s.records, expect.bounds ? { bounds: expect.bounds } : {}))
  return errors
}

