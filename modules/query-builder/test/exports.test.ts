import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AnnotationDocument, QueryResult, makeResult, validateAnnotationDocument } from "@deadlock-query/contracts"
import { buildExport, isProvisional, resultToAnnotations, PROVISIONAL_WARNING_PREFIX } from "../src/export/exports.ts"
import { makeQueryEngine } from "../src/engine/engine.ts"
import { projectResult } from "../src/engine/project.ts"
import { Effect, Stream } from "effect"
import { QueryEngine, type QueryOutput } from "@deadlock-query/contracts"

const meta = { source: "map.guardians", apiVersion: "0.1.0", mapName: "dl_midtown", gameBuildId: "123" }
const sample = () => projectResult([
  ["g1", [0, 0, 0], [[0, 0, 0], [10, 0, 0], [10, 10, 5]], 4.5, true],
  ["g1", [1, 2, 3], [[1, 1, 1], [2, 2, 2]], null, false],
  ['we, "quote"\nnewline', [5, 5, 5], [[0, 0, 0], [1, 0, 0]], 0, true]
], { compileMs: 1, runMs: 2 })

/** Minimal RFC 4180 reader, to prove the CSV parses back to the table. */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = [], cell = "", quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false } else cell += c }
    else if (c === '"') quoted = true
    else if (c === ",") { row.push(cell); cell = "" }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = "" }
    else cell += c
  }
  return rows
}

test("CSV parses back to the table, including quotes, commas, newlines and nested geometry", () => {
  const r = sample()
  const f = buildExport(r, "csv", meta)
  expect(f).toMatchObject({ filename: "query-result.csv", mime: "text/csv" })
  const rows = parseCsv(f.text)
  expect(rows[0]).toEqual(r.columns.map((c) => c.name))
  expect(rows.slice(1).map((x) => x[0])).toEqual(["g1", "g1", 'we, "quote"\nnewline'])
  expect(JSON.parse(rows[1]![2]!)).toEqual([[0, 0, 0], [10, 0, 0], [10, 10, 5]])
  expect(rows[2]![3]).toBe("")
  expect(rows).toHaveLength(r.rows.length + 1)
})

test("JSON is a valid QueryResult plus metadata", () => {
  const r = sample()
  const parsed = JSON.parse(buildExport(r, "json", meta).text)
  expect(Schema.decodeUnknownSync(QueryResult)(parsed)).toEqual(r)
  expect(parsed.metadata).toEqual({ provisional: false, ...meta })
})

test("GeoJSON has one feature per row and geometry column, with metadata as a foreign member", () => {
  const r = sample()
  const g = JSON.parse(buildExport(r, "geojson", meta).text)
  expect(g.type).toBe("FeatureCollection")
  expect(g.features).toHaveLength(r.rows.length * 2)
  expect(g.features[0].geometry).toEqual({ type: "Point", coordinates: [0, 0, 0] })
  expect(g.features[1].geometry.type).toBe("LineString")
  expect(g.metadata).toMatchObject({ mapName: "dl_midtown", provisional: false })
})

test("annotation export is a valid document with unique ids even when a row repeats an entity", () => {
  const r = sample()
  const doc = resultToAnnotations(r, meta)
  expect(Schema.decodeUnknownSync(AnnotationDocument)(JSON.parse(buildExport(r, "annotations", meta).text))).toEqual(doc)
  expect(validateAnnotationDocument(doc)).toEqual([])
  expect(doc).toMatchObject({ mapName: "dl_midtown", gameBuildId: "123", layers: [{ id: "query-result", name: "Query result" }] })
  expect(doc.annotations).toHaveLength(r.rows.length * 2)
  expect(new Set(doc.annotations.map((a) => a.id)).size).toBe(doc.annotations.length)
  expect(doc.annotations.map((a) => a.kind)).toEqual(["point", "polyline", "point", "polyline", "point", "polyline"])
  // Non-geometry cells travel as properties.
  expect(doc.annotations[0]!.properties).toMatchObject({ column: "c2", c1: "g1", c4: 4.5, c5: true })
})

test("a result with no geometry exports an empty annotation document", () => {
  const doc = resultToAnnotations(projectResult([1, 2, 3], { compileMs: 0, runMs: 0 }), meta)
  expect(doc.annotations).toEqual([])
  expect(validateAnnotationDocument(doc)).toEqual([])
})

// PLAN.md §5.3: the provisional flag is included in exports' metadata.
test("provisional results are flagged in every export", () => {
  const r = makeResult([{ name: "p", type: "point" }], [[[1, 2, 3]]], [], { warnings: [`${PROVISIONAL_WARNING_PREFIX} placeholders.`] })
  expect(isProvisional(r)).toBe(true)
  expect(buildExport(r, "csv").filename).toBe("query-result.provisional.csv")
  expect(JSON.parse(buildExport(r, "json").text).metadata.provisional).toBe(true)
  expect(JSON.parse(buildExport(r, "geojson").text).metadata.provisional).toBe(true)
  const doc = resultToAnnotations(r)
  expect(doc.layers![0]!.name).toBe("Query result (provisional)")
  expect(doc.annotations[0]!.properties).toMatchObject({ provisional: true })
  expect(isProvisional(sample())).toBe(false)
})

test("the engine marks a run provisional when the sandbox reports placeholder semantics", async () => {
  const layer = makeQueryEngine({
    compiler: { compile: async () => ({ js: "1", diagnostics: [] }) },
    runner: { run: async () => ({ ok: true, value: [[1]], ms: 1, provisional: true }), cancel: async () => {} }
  })
  const outputs = await Effect.runPromise(Effect.gen(function* () { return yield* Stream.runCollect((yield* QueryEngine).run("1")) }).pipe(Effect.provide(layer)))
  const result = Array.from(outputs as Iterable<QueryOutput>).find((o) => o._tag === "result")
  expect(result?._tag === "result" && isProvisional(result.result)).toBe(true)
})
