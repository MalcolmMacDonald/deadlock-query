import type { MetadataRecord } from "@deadlock-query/contracts"
import type { ValidationContext } from "./context.ts"
import { validateRecords } from "./validate.ts"

export interface RebaseResult {
  /** Accepted records that still fit, and stale ones that do not (`status: "stale"`, reason in `provenance.comment`). */
  readonly records: ReadonlyArray<MetadataRecord>
  readonly kept: number
  readonly stale: ReadonlyArray<{ readonly id: string; readonly reason: string }>
  /** Collision checks were skipped (no probe): only bounds and shape could be tested. */
  readonly degraded: boolean
}

/**
 * Carry accepted (and previously stale) records to a new game build. Each is re-validated against the new map in `ctx`
 * (bounds, and collision when a probe is given); one with an error becomes `stale` with the reason, the rest stay
 * `accepted`. Proposed and rejected records are not carried: they stay in git history. A stale record can be re-confirmed
 * by a reviewer or moved; it is never silently dropped.
 */
export const rebaseRecords = (records: ReadonlyArray<MetadataRecord>, ctx: ValidationContext): RebaseResult => {
  const carried = records.filter((r) => r.status === "accepted" || r.status === "stale")
  // Judge each alone so one bad record does not hide behind another's duplicate; cross-record rules run on the survivors.
  const verdict = new Map<string, string>()
  for (const r of carried) {
    const rep = validateRecords([{ ...r, status: "accepted" }], { ...ctx, existing: [] })
    const err = rep.issues.find((i) => i.severity === "error")
    if (err) verdict.set(r.id, err.message)
  }
  const survivors = carried.filter((r) => !verdict.has(r.id))
  for (const i of validateRecords(survivors.map((r) => ({ ...r, status: "accepted" as const })), ctx).issues) {
    if (i.severity === "error" && i.recordId !== undefined && !verdict.has(i.recordId)) verdict.set(i.recordId, i.message)
  }
  const out = carried.map((r): MetadataRecord => {
    const reason = verdict.get(r.id)
    if (reason) return { ...r, status: "stale", provenance: { ...r.provenance, comment: reason.slice(0, 1000) } }
    const { comment: _drop, ...rest } = r.provenance
    return { ...r, status: "accepted", provenance: r.status === "stale" ? rest : r.provenance }
  })
  return {
    records: out, kept: out.filter((r) => r.status === "accepted").length,
    stale: out.filter((r) => r.status === "stale").map((r) => ({ id: r.id, reason: r.provenance.comment ?? "" })),
    degraded: ctx.collision === undefined
  }
}
