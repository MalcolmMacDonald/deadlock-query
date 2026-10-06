import { Effect } from "effect"
import { ViewerService, type OverlayFeature, type OverlayStyle, type QueryResult, type Vec3 } from "@deadlock-query/contracts"

/** Default viewer layer for a result; further geometry columns get `<id>~<n>` so each can have its own colour. */
export const RESULT_LAYER_ID = "query-result"

/** One colour per geometry column (the first matches the viewer's default marker colour). */
export const COLUMN_COLORS: ReadonlyArray<string> = ["#ffcc00", "#4fc3ff", "#ff7ab8", "#7bd88f", "#c792ff", "#ff9a4f"]

const MAX_LABEL = 40

/** Layer id for the nth geometry column of a result. */
export const columnLayerId = (layerId: string, n: number): string => (n === 0 ? layerId : `${layerId}~${n}`)

/** Convert a geometry value to OverlayFeatures, one per row for that geometry column. */
export const geometryToFeatures = (
  result: QueryResult,
  geometryColumnName: string
): Array<{ rowId: string; row: number; feature: OverlayFeature }> => {
  const colIdx = result.columns.findIndex((c) => c.name === geometryColumnName)
  if (colIdx === -1) return []

  const colType = result.columns[colIdx]!.type
  const features: Array<{ rowId: string; row: number; feature: OverlayFeature }> = []

  for (let i = 0; i < result.rows.length; i++) {
    const value = result.rows[i]![colIdx]
    const rowId = result.rowIds[i]!
    if (value === null || value === undefined) continue

    let feature: OverlayFeature | null = null
    switch (colType) {
      case "point":
        feature = { type: "point", at: value as Vec3 }
        break
      case "segment":
      case "polyline":
        feature = { type: "polyline", points: value as Vec3[] }
        break
      case "polygon":
        feature = { type: "polygon", ring: value as Vec3[] }
        break
    }

    if (feature) features.push({ rowId, row: i, feature })
  }

  return features
}

const short = (v: unknown): string => {
  const s = typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v)
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s
}

/**
 * What a map label says about a feature: the nearest string or number cell to the left of its geometry column (an
 * entity id, a name, a distance), else the first such cell in the row, else the row number. The label names the
 * thing the geometry belongs to, never the plumbing that links it to the table.
 */
export const rowLabel = (result: QueryResult, row: number, geometryColumnName: string): string => {
  const geometry = new Set(result.geometryColumns)
  const at = result.columns.findIndex((c) => c.name === geometryColumnName)
  const usable = (i: number): boolean => {
    const v = result.rows[row]![i]
    return !geometry.has(result.columns[i]!.name) && (typeof v === "string" || typeof v === "number") && v !== ""
  }
  for (let i = at - 1; i >= 0; i--) if (usable(i)) return short(result.rows[row]![i])
  for (let i = 0; i < result.columns.length; i++) if (usable(i)) return short(result.rows[row]![i])
  return `#${row + 1}`
}

/** The other columns of a result row (everything but its geometry columns), keyed by column name, for the viewer's inspector. */
export const rowProperties = (result: QueryResult, row: number): Record<string, unknown> => {
  const geometry = new Set(result.geometryColumns)
  const out: Record<string, unknown> = {}
  result.columns.forEach((c, i) => { if (!geometry.has(c.name)) out[c.name] = result.rows[row]![i] })
  return out
}

export interface ResultLayer {
  readonly id: string
  readonly column: string
  readonly style: OverlayStyle
  readonly features: ReadonlyArray<OverlayFeature>
}

/**
 * Overlay layers for a result: one per geometry column, each in its own colour. Feature ids follow the viewer's own
 * scheme (`<layerId>:<index>`, see map-viewer `featureId`), which is what `pick` events and `highlight` use; the maps
 * tie them to table row ids both ways.
 */
export const overlayFeatures = (result: QueryResult, layerId: string = RESULT_LAYER_ID) => {
  const layers: ResultLayer[] = []
  const featureToRow = new Map<string, string>()
  const rowToFeatures = new Map<string, string[]>()
  const props = new Map<number, Record<string, unknown>>() // shared by a row's features, one per geometry column
  const propsOf = (row: number) => { let p = props.get(row); if (!p) props.set(row, p = rowProperties(result, row)); return p }
  result.geometryColumns.forEach((geomCol, n) => {
    const id = columnLayerId(layerId, n)
    const features: OverlayFeature[] = []
    for (const { rowId, row, feature } of geometryToFeatures(result, geomCol)) {
      const featureId = `${id}:${features.length}`
      featureToRow.set(featureId, rowId)
      rowToFeatures.set(rowId, [...(rowToFeatures.get(rowId) ?? []), featureId])
      features.push({ ...feature, label: rowLabel(result, row, geomCol), properties: propsOf(row) })
    }
    if (features.length > 0) layers.push({ id, column: geomCol, style: { color: COLUMN_COLORS[n % COLUMN_COLORS.length]! }, features })
  })
  return { layers, features: layers.flatMap((l) => l.features), featureToRow, rowToFeatures }
}

/** Ids of the layers a result occupies, so the next result (or dispose) can clear what it no longer uses. */
export const resultLayerIds = (result: QueryResult, layerId: string = RESULT_LAYER_ID): ReadonlyArray<string> =>
  overlayFeatures(result, layerId).layers.map((l) => l.id)

/** Sets one overlay layer per geometry column; removes `layerId`-family layers the result no longer fills. */
export const setResultOverlay = (
  layerId: string,
  result: QueryResult,
  previous: ReadonlyArray<string> = [layerId]
): Effect.Effect<ReadonlyArray<string>, Error, ViewerService> =>
  Effect.gen(function* () {
    const viewer = yield* ViewerService
    const { layers } = overlayFeatures(result, layerId)
    const keep = new Set(layers.map((l) => l.id))
    for (const id of previous) if (!keep.has(id)) yield* viewer.removeOverlay(id)
    for (const l of layers) yield* viewer.setOverlay(l.id, l.features, l.style)
    return layers.map((l) => l.id)
  })
