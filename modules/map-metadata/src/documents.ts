import {
  MetadataBundle, MetadataFile, Submission, decodeVersioned, verifyMetadataBundle,
  type MetadataBundle as Bundle, type MetadataFile as File, type MetadataKind, type MetadataRecord, type Submission as Sub
} from "@deadlock-query/contracts"
import { Effect, Schema } from "effect"
import type { ValidationContext } from "./context.ts"
import { issue, makeReport, type Issue, type ValidationReport } from "./issues.ts"
import { isMetadataKind } from "./kinds.ts"
import { identityIssues, validateRecords, validateSubmissionRecords } from "./validate.ts"

export type DocumentType = "file" | "bundle" | "submission"

/** Size limits in bytes: a submission is small and arrives over the network, data files are committed by reviewed PRs. */
export const MAX_BYTES: Readonly<Record<DocumentType, number>> = { submission: 256 * 1024, file: 5 * 1024 * 1024, bundle: 20 * 1024 * 1024 }

export interface DocumentOptions {
  /** Force the type; by default it is told from the shape (`createdAt` = submission, `contentHash` = bundle). */
  readonly as?: DocumentType
  /** File name without directory, e.g. `creepCamp.json`: a per-kind file may only hold that kind. */
  readonly fileName?: string
  readonly maxBytes?: number
}

export const detectType = (json: unknown): DocumentType => {
  const o = (json ?? {}) as Record<string, unknown>
  return "contentHash" in o ? "bundle" : "createdAt" in o || "submitter" in o ? "submission" : "file"
}

const SCHEMAS = { file: MetadataFile, bundle: MetadataBundle, submission: Submission } as const

/** Decode with the version gate; schema failures become one `schema` issue carrying the decoder's message. */
export const decodeDocument = (type: DocumentType, json: unknown): { readonly doc: File | Bundle | Sub } | { readonly issue: Issue } => {
  const r = Effect.runSync(Effect.result(decodeVersioned(SCHEMAS[type] as Schema.Codec<File | Bundle | Sub>, 1)(json)))
  if (r._tag === "Success") return { doc: r.success }
  const err = r.failure as { readonly _tag?: string; readonly message?: string }
  return { issue: issue("error", err._tag === "UnsupportedSchemaVersion" ? "schema-version" : "schema", err.message ?? String(err)) }
}

/** The kind a per-kind file name stands for (`creepCamp.json`), if it is one. */
export const kindOfFileName = (name: string): MetadataKind | undefined => {
  const base = name.replace(/\.json$/, "")
  return isMetadataKind(base) ? base : undefined
}

const fileKindIssues = (records: ReadonlyArray<MetadataRecord>, fileName: string | undefined): Issue[] => {
  const kind = fileName ? kindOfFileName(fileName) : undefined
  return kind ? records.filter((r) => r.kind !== kind).map((r) => issue("error", "wrong-file-kind", `${fileName} holds only ${kind} records but "${r.id}" is ${r.kind}`, { recordId: r.id })) : []
}

/** Validate one JSON document (text or already parsed): parse, size, schema + version, then the semantic rules. */
export const checkDocument = (input: string | unknown, ctx: ValidationContext = {}, opts: DocumentOptions = {}): ValidationReport => {
  const degraded = ctx.collision === undefined
  let json: unknown = input
  if (typeof input === "string") {
    try { json = JSON.parse(input) } catch (e) { return makeReport([issue("error", "json", `not valid JSON: ${(e as Error).message}`)], degraded) }
  }
  const type = opts.as ?? detectType(json)
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input).length
    const max = opts.maxBytes ?? MAX_BYTES[type]
    if (bytes > max) return makeReport([issue("error", "too-large", `${type} is ${bytes} bytes, the limit is ${max}`)], degraded)
  }
  const d = decodeDocument(type, json)
  if ("issue" in d) return makeReport([d.issue], degraded)
  const doc = d.doc
  if (type === "submission") return validateSubmissionRecords(doc as Sub, ctx)
  const out: Issue[] = [...identityIssues(doc as File | Bundle, ctx), ...fileKindIssues(doc.records, opts.fileName)]
  if (type === "bundle" && !verifyMetadataBundle(doc as Bundle)) out.push(issue("error", "hash-mismatch", "contentHash does not match the records: the bundle was edited or truncated"))
  return makeReport([...out, ...validateRecords(doc.records, ctx).issues], degraded)
}
