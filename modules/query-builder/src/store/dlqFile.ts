import { Schema } from "effect"

/** `.dlq.json`: queries exchanged as files. One or many, each with the library version it was written for. */
const Entry = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  apiVersion: Schema.optionalKey(Schema.String)
})
export const DlqFile = Schema.Struct({
  kind: Schema.Literal("deadlock-query"),
  version: Schema.Literal(1),
  queries: Schema.Array(Entry)
})
export type DlqFile = typeof DlqFile.Type
export type DlqEntry = typeof Entry.Type

export const MAX_DLQ_FILE_BYTES = 2_000_000

export const exportDlq = (queries: ReadonlyArray<DlqEntry>): string =>
  JSON.stringify({ kind: "deadlock-query", version: 1, queries } satisfies DlqFile, null, 2) + "\n"

/** Parses and validates a `.dlq.json` file's text; throws a readable error for anything else. */
export const parseDlq = (text: string): DlqFile => {
  if (text.length > MAX_DLQ_FILE_BYTES) throw new Error("That file is too large to be a query file.")
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error("That file is not valid JSON.") }
  try {
    return Schema.decodeUnknownSync(DlqFile)(raw)
  } catch {
    throw new Error("That file is not a Deadlock Query file (expected kind \"deadlock-query\", version 1, and a list of queries with name and source).")
  }
}

/** File name for a single query: a safe slug of its name. */
export const dlqFilename = (name: string): string => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "query"}.dlq.json`
