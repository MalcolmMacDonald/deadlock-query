import {
  validateMetadataRecords, distance, type MetadataRecord, type Vec3
} from "@deadlock-query/contracts"
import { DEFAULT_OVERLAP_FLOOR_TOLERANCE, type ValidationContext } from "./context.ts"
import { ringsOverlap } from "./geometry.ts"
import { issue, makeReport, type Issue, type ValidationReport } from "./issues.ts"
import { kindDefinition } from "./kinds.ts"

/** Map the plain strings from contracts' cross-field rules to stable codes. */
const fromContracts = (message: string): Issue => {
  const code = message.startsWith("duplicate record id") ? "duplicate-id"
    : message.includes("has no area") ? "polygon-no-area"
    : message.includes("same point") ? "link-degenerate"
    : message.includes("outside the map bounds") ? "out-of-bounds"
    : "invariant"
  const id = /"([^"]+)"/.exec(message)?.[1]
  return issue("error", code, message, id !== undefined ? { recordId: id } : {})
}

const ringOf = (r: MetadataRecord): ReadonlyArray<Vec3> | undefined => r.kind === "walkableRegion" ? r.ring : undefined
const positionOf = (r: MetadataRecord): Vec3 | undefined =>
  r.kind === "creepCamp" || r.kind === "sinnersSacrifice" || r.kind === "healingOrb" ? r.position : undefined

/** Rules over the set: points of one kind closer than the kind's radius, overlapping walkable regions. */
const crossRecordIssues = (records: ReadonlyArray<MetadataRecord>, existing: ReadonlyArray<MetadataRecord>, ctx: ValidationContext): Issue[] => {
  const out: Issue[] = []
  const ids = new Set(records.map((r) => r.id))
  // Existing records with an id in this batch are the same feature being edited, not something to collide with.
  const others = existing.filter((e) => !ids.has(e.id))
  const all = [...records, ...others]
  for (let i = 0; i < records.length; i++) {
    const a = records[i]!
    const pa = positionOf(a)
    const radius = kindDefinition(a.kind).uniqueness?.radius
    for (let j = 0; j < all.length; j++) {
      const b = all[j]!
      // Within the batch report each pair once; against existing records the batch record is always `a`.
      if (b === a || (j < records.length && j < i)) continue
      if (b.status === "rejected" || b.status === "stale") continue
      if (pa && radius !== undefined && b.kind === a.kind) {
        const pb = positionOf(b)!
        const d = distance(pa, pb)
        if (d < radius) out.push(issue("error", "duplicate-nearby", `${a.kind} "${a.id}" is ${Math.round(d)} units from "${b.id}" (minimum ${radius})`, { recordId: a.id, at: pa }))
      }
      const ra = ringOf(a), rb = ringOf(b)
      if (ra && rb && a.kind === "walkableRegion" && b.kind === "walkableRegion" && a.flag === b.flag
          && Math.abs(a.floorZ - b.floorZ) < (ctx.overlapFloorTolerance ?? DEFAULT_OVERLAP_FLOOR_TOLERANCE)
          && ringsOverlap(ra, rb)) {
        out.push(issue("warning", "regions-overlap", `${a.flag} regions "${a.id}" and "${b.id}" overlap at the same floor height`, { recordId: a.id, at: ra[0]! }))
      }
    }
  }
  return out
}

/** Per-record validators from the kinds registry, then the cross-record rules. Does not repeat the contracts rules. */
const semanticIssues = (records: ReadonlyArray<MetadataRecord>, ctx: ValidationContext): Issue[] => [
  ...records.flatMap((r) => kindDefinition(r.kind).validators.flatMap((v) => v(r, ctx))),
  ...crossRecordIssues(records, ctx.existing ?? [], ctx)
]

const contractIssues = (records: ReadonlyArray<MetadataRecord>, ctx: ValidationContext): Issue[] =>
  validateMetadataRecords(records, {
    ...(ctx.bounds ? { bounds: ctx.bounds } : {}),
    ...(ctx.boundsMargin !== undefined ? { boundsMargin: ctx.boundsMargin } : {}),
    ...(ctx.minArea !== undefined ? { minArea: ctx.minArea } : {})
  }).map(fromContracts)

export const identityIssues = (doc: { readonly gameBuildId: string; readonly mapName: string }, ctx: ValidationContext): Issue[] => {
  const out: Issue[] = []
  if (ctx.expect?.gameBuildId !== undefined && doc.gameBuildId !== ctx.expect.gameBuildId)
    out.push(issue("error", "build-mismatch", `gameBuildId "${doc.gameBuildId}" is not the loaded build "${ctx.expect.gameBuildId}"`))
  if (ctx.expect?.mapName !== undefined && doc.mapName !== ctx.expect.mapName)
    out.push(issue("error", "map-mismatch", `mapName "${doc.mapName}" is not the loaded map "${ctx.expect.mapName}"`))
  return out
}

/** Validate a set of records (already decoded by the schema): contracts invariants, per-kind rules, duplicates, overlaps. */
export const validateRecords = (records: ReadonlyArray<MetadataRecord>, ctx: ValidationContext = {}): ValidationReport =>
  makeReport([...contractIssues(records, ctx), ...semanticIssues(records, ctx)], ctx.collision === undefined)

/** Shared by the editor ("Review & submit"), the submit worker and the review panel. Every record must be `proposed`. */
export const validateSubmissionRecords = (
  s: { readonly gameBuildId: string; readonly mapName: string; readonly records: ReadonlyArray<MetadataRecord> },
  ctx: ValidationContext = {}
): ValidationReport => {
  const status = s.records.filter((r) => r.status !== "proposed")
    .map((r) => issue("error", "not-proposed", `record "${r.id}" has status "${r.status}": a submission may only contain proposed records`, { recordId: r.id }))
  return makeReport([...identityIssues(s, ctx), ...status, ...contractIssues(s.records, ctx), ...semanticIssues(s.records, ctx)], ctx.collision === undefined)
}
