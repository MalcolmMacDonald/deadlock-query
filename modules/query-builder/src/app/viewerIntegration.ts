import { Effect, Stream } from "effect"
import { SelectionBus, ViewerService, type OverlayFeature, type QueryResult, type Vec3 } from "@deadlock-query/contracts"

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

/** Set overlay on the viewer for all geometry in the result. Generates feature IDs from row IDs. */
export const setResultOverlay = (layerId: string, result: QueryResult): Effect.Effect<void, Error, ViewerService> =>
  Effect.gen(function* () {
    const viewer = yield* ViewerService
    const features: OverlayFeature[] = []
    const featureToRow: Record<string, string> = {} // maps feature ID to row ID

    for (const geomCol of result.geometryColumns) {
      const converted = geometryToFeatures(result, geomCol)
      for (const { rowId, feature } of converted) {
        const featureId = `${rowId}:${geomCol}`
        featureToRow[featureId] = rowId
        features.push({ ...feature, label: featureId })
      }
    }

    if (features.length > 0) {
      yield* viewer.setOverlay(layerId, features)
    }
  })

/** When a row is selected, highlight the corresponding features on the map. */
export const syncSelectionToViewer = (): Effect.Effect<void, never, ViewerService | SelectionBus> =>
  Effect.gen(function* () {
    const bus = yield* SelectionBus
    const viewer = yield* ViewerService

    const ids = yield* bus.current
    const featureIds = ids.flatMap((rowId) => [`${rowId}:position`, `${rowId}:geometry`])
    if (featureIds.length > 0) {
      yield* viewer.highlight(featureIds)
    }
  })

/** Listen to viewer events and sync pick events to SelectionBus. */
export const syncViewerToSelection = (): Stream.Stream<never, never, ViewerService | SelectionBus> =>
  Stream.fromEffect(ViewerService).pipe(
    Stream.flatMap((viewer) => viewer.events),
    Stream.tap((event) =>
      event._tag === "pick"
        ? Effect.gen(function* () {
          const bus = yield* SelectionBus
          const rowId = event.id.split(":")[0]! // Extract rowId from "rowId:colName"
          yield* bus.select([rowId])
        })
        : Effect.void
    ),
    Stream.drain
  )
