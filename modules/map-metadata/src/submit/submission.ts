import { Effect, Schema } from "effect"
import { SCHEMA_VERSION, Submission, canonicalJson, type MetadataRecord, type Submitter } from "@deadlock-query/contracts"
import type { ValidationContext } from "../context.ts"
import { issue, makeReport, type Issue, type ValidationReport } from "../issues.ts"
import { validateSubmissionRecords } from "../validate.ts"

export interface SubmissionMeta {
  readonly gameBuildId: string
  readonly mapName: string
  readonly submitter: Submitter
  readonly note?: string
  /** Injected for tests; default is the current time. */
  readonly now?: Date
  /** Injected for tests; default is random. */
  readonly id?: string
}

export type BuildResult =
  | { readonly ok: true; readonly submission: Submission; readonly report: ValidationReport }
  | { readonly ok: false; readonly report: ValidationReport }

const newSubmissionId = (now: Date): string => {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("")
  return `sub-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${rand}`
}

/** Mirror of the schema's own Text(n) limits that the editor can hit with free text; the schema stays the final judge. */
const trimmed = (s: string | undefined): string | undefined => { const t = s?.trim(); return t ? t : undefined }

/**
 * Turns drafts into a `Submission`: every record `proposed`, stamped with the submitter and submission id, then checked
 * with the module's validators (`ctx` carries bounds, accepted records and, in the editor, the collision probe) and the
 * contracts schema. Only warnings still produce a submission; any error returns just the report.
 */
export const buildSubmission = (drafts: ReadonlyArray<MetadataRecord>, meta: SubmissionMeta, ctx: ValidationContext = {}): BuildResult => {
  const now = meta.now ?? new Date()
  const id = meta.id ?? newSubmissionId(now)
  const createdAt = now.toISOString()
  const name = trimmed(meta.submitter.name)
  const github = trimmed(meta.submitter.github)?.replace(/^@/, "")
  if (!name) return { ok: false, report: makeReport([issue("error", "submitter-name", "Enter a display name so reviewers know who sent this")], ctx.collision === undefined) }
  if (drafts.length === 0) return { ok: false, report: makeReport([issue("error", "empty", "Nothing to submit: draw at least one feature first")], ctx.collision === undefined) }
  const submitter: Submitter = { name, ...(github ? { github } : {}) }
  const records = drafts.map((r): MetadataRecord => ({ ...r, status: "proposed", provenance: { submitter, submissionId: id, submittedAt: createdAt } }))
  const note = trimmed(meta.note)
  const doc = { schemaVersion: SCHEMA_VERSION, id, gameBuildId: meta.gameBuildId, mapName: meta.mapName, createdAt, submitter, ...(note ? { note } : {}), records }
  const report = validateSubmissionRecords(doc, { ...ctx, expect: { ...ctx.expect, gameBuildId: meta.gameBuildId, mapName: meta.mapName } })
  const decoded = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Submission)(doc)))
  if (decoded._tag === "Failure") {
    const schemaIssue: Issue = issue("error", "schema", String((decoded.failure as { message?: string }).message ?? decoded.failure))
    return { ok: false, report: makeReport([...report.issues, schemaIssue], report.degraded) }
  }
  return report.ok ? { ok: true, submission: decoded.success, report } : { ok: false, report }
}

/** The file a contributor downloads: stable key order, pretty-printed, newline-terminated. */
export const submissionFile = (s: Submission): { readonly name: string; readonly text: string } => ({
  name: `metadata-submission-${s.id}.json`,
  text: JSON.stringify(JSON.parse(canonicalJson(s)), null, 2) + "\n"
})

export const DEFAULT_ISSUE_REPO = "MalcolmMacDonald/deadlock-query"
/** Browsers and GitHub reject very long URLs; above this the JSON is attached by hand instead of inlined. */
export const MAX_ISSUE_URL = 7000

/**
 * A prefilled "new issue" link for the no-backend fallback. When the JSON fits it is inlined in a code block to paste
 * into a file; otherwise the body tells the contributor to attach the downloaded file. Plain text only.
 */
export const issueLink = (s: Submission, opts: { readonly repo?: string; readonly maxUrl?: number } = {}): { readonly url: string; readonly inlined: boolean } => {
  const repo = opts.repo ?? DEFAULT_ISSUE_REPO
  const title = `Metadata submission ${s.id}: ${s.records.length} feature${s.records.length === 1 ? "" : "s"} (${s.mapName} ${s.gameBuildId})`
  const head = [
    `Submitted by ${s.submitter.name}${s.submitter.github ? ` (@${s.submitter.github}, unverified)` : ""}.`,
    "",
    ...(s.note ? [s.note, ""] : [])
  ]
  const attach = [...head, `Please attach \`${submissionFile(s).name}\` (downloaded from the editor) to this issue by dragging it into this box.`].join("\n")
  const build = (body: string) => `https://github.com/${repo}/issues/new?labels=metadata-submission&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  const inline = [...head, "Save the block below as a `.json` file or attach your downloaded copy:", "", "```json", submissionFile(s).text.trimEnd(), "```"].join("\n")
  const inlineUrl = build(inline)
  return inlineUrl.length <= (opts.maxUrl ?? MAX_ISSUE_URL) ? { url: inlineUrl, inlined: true } : { url: build(attach), inlined: false }
}
