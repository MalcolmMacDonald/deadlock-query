import { Effect } from "effect"
import { ViewerService, type OverlayFeature, type QueryResult, type Vec3 } from "@deadlock-query/contracts"

/** Convert a geometry value to OverlayFeatures, one per row for that geometry column. */
export const geometryToFeatures = (
  result: QueryResult,
  geometryColumnName: string
): Array<{ rowId: string; feature: OverlayFeature }> => {
  const colIdx = result.columns.findIndex((c) => c.name === geometryColumnName)
  if (colIdx === -1) return []

  const colType = result.columns[colIdx]!.type
  const features: Array<{ rowId: string; feature: OverlayFeature }> = []

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

    if (feature) features.push({ rowId, feature })
  }

  return features
}

/** Overlay features for every geometry column of a result, with the feature-id ↔ row-id mapping both ways. */
export const overlayFeatures = (result: QueryResult) => {
  const features: OverlayFeature[] = []
  const featureToRow = new Map<string, string>()
  const rowToFeatures = new Map<string, string[]>()
  for (const geomCol of result.geometryColumns) {
    for (const { rowId, feature } of geometryToFeatures(result, geomCol)) {
      const featureId = `${rowId}:${geomCol}`
      featureToRow.set(featureId, rowId)
      rowToFeatures.set(rowId, [...(rowToFeatures.get(rowId) ?? []), featureId])
      features.push({ ...feature, label: featureId })
    }
  }
  return { features, featureToRow, rowToFeatures }
}

/** Set overlay on the viewer for all geometry in the result; clears a stale overlay when the result has none. */
export const setResultOverlay = (layerId: string, result: QueryResult): Effect.Effect<void, Error, ViewerService> =>
  Effect.gen(function* () {
    const viewer = yield* ViewerService
    const { features } = overlayFeatures(result)
    if (features.length > 0) yield* viewer.setOverlay(layerId, features)
    else yield* viewer.removeOverlay(layerId)
  })
