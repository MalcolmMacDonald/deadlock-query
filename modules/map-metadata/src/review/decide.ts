import { SCHEMA_VERSION, canonicalJson, type MetadataFile, type MetadataKind, type MetadataRecord, type ReviewDecision, type Submission } from "@deadlock-query/contracts"

/** The reviewer's call on one record. `changesRequested` leaves the record out of the data (the PR stays open). */
export interface RecordDecision { readonly recordId: string; readonly decision: ReviewDecision["decision"]; readonly comment?: string | undefined }

/** Stamps a record with the review outcome. Provenance from the submitter is kept. */
export const stamp = (r: MetadataRecord, d: RecordDecision, reviewer: string, now: Date): MetadataRecord => ({
  ...r,
  status: d.decision === "accepted" ? "accepted" : "rejected",
  provenance: {
    ...r.provenance, reviewer, reviewedAt: now.toISOString(),
    ...(d.comment?.trim() ? { comment: d.comment.trim().slice(0, 1000) } : {})
  }
})

export interface Outcome {
  /** New or changed per-kind file contents to commit: `data/metadata/<build>/<kind>.json`. */
  readonly files: ReadonlyArray<{ readonly kind: MetadataKind; readonly path: string; readonly text: string }>
  readonly accepted: number
  readonly rejected: number
  readonly pending: number
}

const byId = (a: MetadataRecord, b: MetadataRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** `existing`: the current file per kind, if the build already has one. Records replace the same id; the result is sorted by id. */
export const mergeIntoFile = (
  meta: { readonly gameBuildId: string; readonly mapName: string },
  existing: MetadataFile | undefined,
  add: ReadonlyArray<MetadataRecord>
): MetadataFile => {
  const ids = new Set(add.map((r) => r.id))
  const kept = (existing?.records ?? []).filter((r) => !ids.has(r.id))
  return { schemaVersion: existing?.schemaVersion ?? SCHEMA_VERSION, gameBuildId: meta.gameBuildId, mapName: meta.mapName, records: [...kept, ...add].sort(byId) }
}

export const fileText = (f: MetadataFile): string => JSON.stringify(JSON.parse(canonicalJson(f)), null, 2) + "\n"
export const dataPath = (gameBuildId: string, kind: MetadataKind): string => `data/metadata/${gameBuildId}/${kind}.json`

/**
 * What accepting a submission commits: every decided record (accepted or rejected, so a rejection is on record) merged
 * into its per-kind file. Records without a decision, or `changesRequested`, stay out. `existing` maps kind to the file
 * currently on the branch.
 */
export const applyDecisions = (
  s: Submission, decisions: ReadonlyArray<RecordDecision>, reviewer: string, now: Date,
  existing: Readonly<Partial<Record<MetadataKind, MetadataFile>>> = {}
): Outcome => {
  const by = new Map(decisions.map((d) => [d.recordId, d]))
  const stamped: MetadataRecord[] = []
  let pending = 0
  for (const r of s.records) {
    const d = by.get(r.id)
    if (!d || d.decision === "changesRequested") { pending++; continue }
    stamped.push(stamp(r, d, reviewer, now))
  }
  const kinds = [...new Set(stamped.map((r) => r.kind))].sort()
  const files = kinds.map((kind) => ({
    kind, path: dataPath(s.gameBuildId, kind),
    text: fileText(mergeIntoFile(s, existing[kind], stamped.filter((r) => r.kind === kind)))
  }))
  const accepted = stamped.filter((r) => r.status === "accepted").length
  return { files, accepted, rejected: stamped.length - accepted, pending }
}
