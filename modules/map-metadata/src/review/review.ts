import type { MetadataFile, MetadataKind, Submission } from "@deadlock-query/contracts"
import type { ValidationContext } from "../context.ts"
import type { ValidationReport } from "../issues.ts"
import { validateSubmissionRecords } from "../validate.ts"
import { applyDecisions, type Outcome, type RecordDecision } from "./decide.ts"
import type { QueueItem, ReviewApi } from "./github.ts"

export interface Loaded { readonly item: QueueItem; readonly submission: Submission; readonly report: ValidationReport }

/** Loads a PR's submission and checks it with the module's validators (with accepted data and collision when the context has them). */
export const loadForReview = async (api: ReviewApi, item: QueueItem, ctx: ValidationContext = {}): Promise<Loaded> => {
  const submission = await api.submission(item)
  const report = validateSubmissionRecords(submission, { ...ctx, expect: { ...ctx.expect } })
  return { item, submission, report }
}

/** Bulk helpers: accept every record without an error, reject the rest. */
export const bulkDecisions = (l: Loaded, mode: "acceptValid" | "rejectAll", comment?: string): RecordDecision[] => {
  const bad = new Set(l.report.issues.filter((i) => i.severity === "error" && i.recordId).map((i) => i.recordId!))
  return l.submission.records.map((r) => ({
    recordId: r.id,
    decision: mode === "rejectAll" || bad.has(r.id) ? "rejected" as const : "accepted" as const,
    ...(comment ? { comment } : mode === "acceptValid" && bad.has(r.id) ? { comment: "Failed validation" } : {})
  }))
}

/**
 * Commit the decided records into `data/metadata/<build>/<kind>.json` on the PR branch, then merge. Refuses when nothing
 * is decided or any record is still undecided (`changesRequested` is a comment, not a commit: use `requestChanges`).
 * Everything lands in git on the PR, so the audit trail is the PR history.
 */
export const commitDecisions = async (
  api: ReviewApi, l: Loaded, decisions: ReadonlyArray<RecordDecision>, reviewer: string, now: Date = new Date()
): Promise<Outcome> => {
  const decided = new Set(decisions.filter((d) => d.decision !== "changesRequested").map((d) => d.recordId))
  if (decided.size === 0) throw new Error("Nothing decided: accept or reject at least one record")
  const missing = l.submission.records.filter((r) => !decided.has(r.id))
  if (missing.length > 0) throw new Error(`${missing.length} record${missing.length === 1 ? " is" : "s are"} undecided: decide on every record, or request changes instead`)
  const kinds = [...new Set(l.submission.records.map((r) => r.kind))] as MetadataKind[]
  const current = new Map<MetadataKind, { file: MetadataFile; sha: string }>()
  for (const k of kinds) { const f = await api.dataFile(l.item, l.submission.gameBuildId, k); if (f) current.set(k, f) }
  const outcome = applyDecisions(l.submission, decisions, reviewer, now, Object.fromEntries([...current].map(([k, v]) => [k, v.file])))
  for (const f of outcome.files) await api.commitFile(l.item, f.path, f.text, `Review ${l.submission.id}: ${f.kind}`, current.get(f.kind)?.sha)
  if (outcome.accepted === 0) await api.close(l.item, `Reviewed by ${reviewer}: no records accepted (${outcome.rejected} rejected).`)
  else await api.merge(l.item)
  return outcome
}

export const requestChanges = (api: ReviewApi, l: Loaded, reviewer: string, comment: string): Promise<void> =>
  api.comment(l.item, `Changes requested by ${reviewer}:\n\n${comment}`)

export const rejectSubmission = (api: ReviewApi, l: Loaded, reviewer: string, reason: string): Promise<void> =>
  api.close(l.item, `Rejected by ${reviewer}: ${reason}`)
