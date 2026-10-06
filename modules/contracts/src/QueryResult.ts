import { Schema } from "effect"
import { SCHEMA_VERSION } from "./MapBundle.ts"

export const ColumnType = Schema.Literals([
  "number", "string", "bool", "point", "segment", "polyline", "polygon", "entityRef"
])
export type ColumnType = typeof ColumnType.Type

export const Column = Schema.Struct({ name: Schema.String, type: ColumnType })

export const QueryResult = Schema.Struct({
  schemaVersion: Schema.String,
  columns: Schema.Array(Column),
  /** Cells are JSON values; geometry cells are coordinate arrays in canonical (world) space. */
  rows: Schema.Array(Schema.Array(Schema.Unknown)),
  rowIds: Schema.Array(Schema.String),
  geometryColumns: Schema.Array(Schema.String),
  stats: Schema.Struct({ rowCount: Schema.Number, compileMs: Schema.Number, runMs: Schema.Number }),
  warnings: Schema.Array(Schema.String)
})
export type QueryResult = typeof QueryResult.Type

export const makeResult = (
  columns: QueryResult["columns"], rows: QueryResult["rows"], rowIds: ReadonlyArray<string> = [],
  extra: Partial<Pick<QueryResult, "warnings" | "stats">> = {}
): QueryResult => ({
  schemaVersion: SCHEMA_VERSION,
  columns,
  rows,
  rowIds: rowIds.length > 0 ? [...rowIds] : rows.map((_, i) => String(i)),
  geometryColumns: columns.filter((c) => ["point", "segment", "polyline", "polygon"].includes(c.type)).map((c) => c.name),
  stats: extra.stats ?? { rowCount: rows.length, compileMs: 0, runMs: 0 },
  warnings: extra.warnings ?? []
})

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

type Geometry =
  | { type: "Point"; coordinates: unknown }
  | { type: "LineString"; coordinates: unknown }
  | { type: "Polygon"; coordinates: unknown }

const toGeometry = (type: ColumnType, v: unknown): Geometry | null => {
  if (v === null || v === undefined) return null
  switch (type) {
    case "point": return { type: "Point", coordinates: v }
    case "segment": case "polyline": return { type: "LineString", coordinates: v }
    case "polygon": return { type: "Polygon", coordinates: [v] }
    default: return null
  }
}

/**
 * Pure export. GeoJSON emits one Feature per (row, geometry column), carrying the row's
 * non-geometry cells as `properties`; coordinates stay in Source world units (not WGS84).
 */
export const exportResult = (result: QueryResult, format: "csv" | "json" | "geojson"): string => {
  if (format === "json") return JSON.stringify(result)
  if (format === "csv") {
    const header = result.columns.map((c) => csvCell(c.name)).join(",")
    return [header, ...result.rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n"
  }
  const features: unknown[] = []
  for (const row of result.rows) {
    const properties: Record<string, unknown> = {}
    result.columns.forEach((c, i) => { if (!result.geometryColumns.includes(c.name)) properties[c.name] = row[i] })
    result.columns.forEach((c, i) => {
      if (!result.geometryColumns.includes(c.name)) return
      const geometry = toGeometry(c.type, row[i])
      if (geometry) features.push({ type: "Feature", geometry, properties: { ...properties, geometryColumn: c.name } })
    })
  }
  return JSON.stringify({ type: "FeatureCollection", features })
}
