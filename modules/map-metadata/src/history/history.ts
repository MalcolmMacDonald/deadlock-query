import type { MetadataKind, MetadataRecord, MetadataStatus } from "@deadlock-query/contracts"
import { kindDefinition } from "../kinds.ts"

export interface HistoryRow {
  readonly id: string
  readonly kind: MetadataKind
  readonly label: string
  readonly status: MetadataStatus
  /** "Ada (@ada, unverified)" or "unknown". */
  readonly submitter: string
  readonly submittedAt: string | undefined
  readonly reviewer: string | undefined
  readonly reviewedAt: string | undefined
  readonly comment: string | undefined
  readonly submissionId: string | undefined
  /** One sentence per recorded event, oldest first: the per-feature audit trail as far as the record knows it. */
  readonly events: ReadonlyArray<string>
}

const day = (t: string | undefined) => (t ? t.slice(0, 10) : undefined)

/** Provenance of one record as display rows. Text only: callers must not render it as markup. */
export const historyRow = (r: MetadataRecord): HistoryRow => {
  const p = r.provenance
  const s = p.submitter
  const submitter = s ? `${s.name}${s.github ? ` (@${s.github}, unverified)` : " (unverified)"}` : "unknown"
  const events: string[] = []
  if (p.submittedAt || s) events.push(`Submitted by ${submitter}${day(p.submittedAt) ? ` on ${day(p.submittedAt)}` : ""}${p.submissionId ? ` (${p.submissionId})` : ""}.`)
  if (p.reviewer || p.reviewedAt) {
    const verb = r.status === "accepted" ? "Accepted" : r.status === "rejected" ? "Rejected" : r.status === "stale" ? "Marked stale" : "Reviewed"
    events.push(`${verb}${p.reviewer ? ` by ${p.reviewer}` : ""}${day(p.reviewedAt) ? ` on ${day(p.reviewedAt)}` : ""}${p.comment ? `: ${p.comment}` : "."}`)
  } else if (p.comment) events.push(`Comment: ${p.comment}`)
  return {
    id: r.id, kind: r.kind, label: r.name ?? kindDefinition(r.kind).label, status: r.status, submitter,
    submittedAt: p.submittedAt, reviewer: p.reviewer, reviewedAt: p.reviewedAt, comment: p.comment, submissionId: p.submissionId, events
  }
}

export interface HistoryFilter { readonly status?: MetadataStatus; readonly kind?: MetadataKind; readonly text?: string }

/** Newest activity first (review time, else submission time, else id), then filtered. */
export const historyRows = (records: ReadonlyArray<MetadataRecord>, f: HistoryFilter = {}): ReadonlyArray<HistoryRow> => {
  const text = f.text?.trim().toLowerCase()
  return records.filter((r) => (!f.status || r.status === f.status) && (!f.kind || r.kind === f.kind)).map(historyRow)
    .filter((h) => !text || [h.id, h.label, h.submitter, h.reviewer ?? "", h.comment ?? "", h.submissionId ?? ""].some((x) => x.toLowerCase().includes(text)))
    .sort((a, b) => ((b.reviewedAt ?? b.submittedAt ?? "") < (a.reviewedAt ?? a.submittedAt ?? "") ? -1 : (b.reviewedAt ?? b.submittedAt ?? "") > (a.reviewedAt ?? a.submittedAt ?? "") ? 1 : a.id < b.id ? -1 : 1))
}

export const statusCounts = (records: ReadonlyArray<MetadataRecord>): Readonly<Record<MetadataStatus, number>> => {
  const c: Record<MetadataStatus, number> = { proposed: 0, accepted: 0, rejected: 0, stale: 0 }
  for (const r of records) c[r.status]++
  return c
}
