import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import type { MetadataFile, MetadataRecord } from "@deadlock-query/contracts"
import type { ValidationContext } from "./context.ts"
import { checkDocument, decodeDocument, kindOfFileName } from "./documents.ts"
import { issue, makeReport, type Issue, type ValidationReport } from "./issues.ts"

/** Not part of the worker-safe surface (`index.ts`): this module reads the file system. */

export interface FileReport {
  readonly path: string
  readonly report: ValidationReport
}

/**
 * Validate `data/metadata/<gameBuildId>/`: every `<kind>.json` (and `metadata.bundle.json`) on its own, then the whole build
 * together (ids unique across files, one map name). The directory name must equal each file's `gameBuildId`.
 */
export const checkBuildDir = (dir: string, ctx: ValidationContext = {}): ReadonlyArray<FileReport> => {
  const build = basename(dir)
  const scoped: ValidationContext = { ...ctx, expect: { gameBuildId: build, ...ctx.expect } }
  const names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort()
  const reports: FileReport[] = []
  const merged: MetadataRecord[] = []
  const maps = new Set<string>()
  for (const name of names) {
    const path = join(dir, name)
    if (name === "metadata.bundle.json") { reports.push({ path, report: checkDocument(readFileSync(path, "utf8"), scoped, { as: "bundle", fileName: name }) }); continue }
    if (!kindOfFileName(name)) {
      reports.push({ path, report: makeReport([issue("warning", "unexpected-file", `${name} is not a kind file (<kind>.json) or metadata.bundle.json`)], ctx.collision === undefined) })
      continue
    }
    const text = readFileSync(path, "utf8")
    const report = checkDocument(text, scoped, { as: "file", fileName: name })
    reports.push({ path, report })
    if (report.ok) {
      const d = decodeDocument("file", JSON.parse(text))
      if ("doc" in d) { merged.push(...d.doc.records); maps.add((d.doc as MetadataFile).mapName) }
    }
  }
  const whole: Issue[] = []
  if (maps.size > 1) whole.push(issue("error", "map-mismatch", `files in ${build} name different maps: ${[...maps].sort().join(", ")}`))
  // Whole-build rules only add what a single file cannot see: ids shared between files.
  const seen = new Map<string, number>()
  for (const r of merged) seen.set(r.id, (seen.get(r.id) ?? 0) + 1)
  for (const [id, n] of seen) if (n > 1) whole.push(issue("error", "duplicate-id", `record id "${id}" appears ${n} times in ${build}`, { recordId: id }))
  if (whole.length) reports.push({ path: dir, report: makeReport(whole, ctx.collision === undefined) })
  return reports
}

/** A path is a build directory when it holds JSON files; otherwise each sub-directory is treated as one. */
export const checkPath = (path: string, ctx: ValidationContext = {}): ReadonlyArray<FileReport> => {
  if (!existsSync(path)) return [{ path, report: makeReport([issue("error", "missing", `${path} does not exist`)], ctx.collision === undefined) }]
  if (!statSync(path).isDirectory()) return [{ path, report: checkDocument(readFileSync(path, "utf8"), ctx, { fileName: basename(path) }) }]
  const entries = readdirSync(path)
  if (entries.some((n) => n.endsWith(".json"))) return checkBuildDir(path, ctx)
  return entries.sort().map((n) => join(path, n)).filter((p) => statSync(p).isDirectory()).flatMap((p) => checkBuildDir(p, ctx))
}

export interface BuildData { readonly gameBuildId: string; readonly mapName: string; readonly records: ReadonlyArray<MetadataRecord> }

/** Records of every `<kind>.json` in a build directory (the bundle file is ignored). Throws when a file does not decode. */
export const readBuildDir = (dir: string): BuildData => {
  const records: MetadataRecord[] = []
  let mapName: string | undefined
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json") && kindOfFileName(n)).sort()) {
    const d = decodeDocument("file", JSON.parse(readFileSync(join(dir, name), "utf8")))
    if ("issue" in d) throw new Error(`${join(dir, name)}: ${d.issue.message}`)
    const f = d.doc as MetadataFile
    mapName ??= f.mapName
    records.push(...f.records)
  }
  if (mapName === undefined) throw new Error(`${dir} has no kind files`)
  return { gameBuildId: basename(dir), mapName, records }
}
