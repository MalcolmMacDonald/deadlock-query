import { exportResult, makeAnnotationDocument, validateAnnotationDocument, type Annotation, type AnnotationLayer, type QueryResult } from "@deadlock-query/contracts"

export type ExportFormat = "csv" | "json" | "geojson" | "annotations"

/** Prefix of the warning the engine adds when the map's semantics are placeholders. */
export const PROVISIONAL_WARNING_PREFIX = "Provisional semantics:"
export const isProvisional = (result: QueryResult): boolean => result.warnings.some((w) => w.startsWith(PROVISIONAL_WARNING_PREFIX))

/** Where a result came from: written into the formats that have room for it. */
export interface ExportMeta {
  readonly source?: string
  readonly apiVersion?: string
  readonly mapName?: string
  readonly gameBuildId?: string
}

export interface ExportFile {
  readonly filename: string
  readonly mime: string
  readonly text: string
}

const LAYER_ID = "query-result"
const isPoint = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n))
const isPoints = (v: unknown, min: number): v is Array<[number, number, number]> => Array.isArray(v) && v.length >= min && v.every(isPoint)

/**
 * Geometry columns of a result as an annotation document (one annotation per row and geometry column),
 * so a query's answer can be loaded into the viewer's annotation tools. Row ids are not unique when a
 * row repeats an entity, so ids are made unique with a `#n` suffix. Provisional results are marked in
 * the layer name and on every annotation.
 */
export const resultToAnnotations = (result: QueryResult, meta: ExportMeta = {}) => {
  const provisional = isProvisional(result)
  const layer: AnnotationLayer = { id: LAYER_ID, name: provisional ? "Query result (provisional)" : "Query result" }
  const annotations: Annotation[] = []
  const used = new Set<string>()
  const scalarIdx = result.columns.map((c, i) => [c, i] as const).filter(([c]) => !result.geometryColumns.includes(c.name))
  result.rows.forEach((row, r) => {
    const properties = (column: string) => ({
      rowId: result.rowIds[r] ?? String(r), column, ...(provisional ? { provisional: true } : {}),
      ...Object.fromEntries(scalarIdx.map(([c, i]) => [c.name, row[i] ?? null]))
    })
    result.columns.forEach((c, i) => {
      if (!result.geometryColumns.includes(c.name)) return
      const v = row[i]
      let base = `${result.rowIds[r] ?? r}:${c.name}`
      for (let n = 2; used.has(base); n++) base = `${result.rowIds[r] ?? r}:${c.name}#${n}`
      const common = { id: base, layer: LAYER_ID, properties: properties(c.name) }
      let a: Annotation | undefined
      if (c.type === "point" && isPoint(v)) a = { ...common, kind: "point", points: [v] }
      else if ((c.type === "segment" || c.type === "polyline") && isPoints(v, 2)) a = { ...common, kind: "polyline", points: v }
      else if (c.type === "polygon" && isPoints(v, 3)) a = { ...common, kind: "polygon", points: v }
      if (a) { used.add(base); annotations.push(a) }
    })
  })
  const doc = makeAnnotationDocument(annotations, { layers: [layer], ...(meta.mapName ? { mapName: meta.mapName } : {}), ...(meta.gameBuildId ? { gameBuildId: meta.gameBuildId } : {}) })
  const problems = validateAnnotationDocument(doc)
  if (problems.length) throw new Error(`annotation export is inconsistent: ${problems.join("; ")}`)
  return doc
}

const metadata = (result: QueryResult, meta: ExportMeta) => ({
  provisional: isProvisional(result),
  ...(meta.apiVersion ? { apiVersion: meta.apiVersion } : {}),
  ...(meta.mapName ? { mapName: meta.mapName } : {}),
  ...(meta.gameBuildId ? { gameBuildId: meta.gameBuildId } : {}),
  ...(meta.source !== undefined ? { source: meta.source } : {})
})

/**
 * Serialises a result. CSV has no room for metadata, so a provisional result is flagged in the file
 * name instead; JSON adds a `metadata` member next to the `QueryResult` fields (still a valid
 * `QueryResult`), GeoJSON adds it as a foreign member of the FeatureCollection.
 */
export const buildExport = (result: QueryResult, format: ExportFormat, meta: ExportMeta = {}): ExportFile => {
  const tag = isProvisional(result) ? ".provisional" : ""
  switch (format) {
    case "csv":
      return { filename: `query-result${tag}.csv`, mime: "text/csv", text: exportResult(result, "csv") }
    case "json":
      return { filename: `query-result${tag}.json`, mime: "application/json", text: JSON.stringify({ ...result, metadata: metadata(result, meta) }) }
    case "geojson":
      return { filename: `query-result${tag}.geojson`, mime: "application/geo+json", text: JSON.stringify({ ...JSON.parse(exportResult(result, "geojson")), metadata: metadata(result, meta) }) }
    case "annotations":
      return { filename: `query-result${tag}.annotations.json`, mime: "application/json", text: JSON.stringify(resultToAnnotations(result, meta)) }
  }
}
