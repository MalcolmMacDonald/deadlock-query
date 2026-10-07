import type { MetadataRecord, NavLinkKind, RegionFlag, Vec3 } from "@deadlock-query/contracts"
import type { MetadataKind } from "@deadlock-query/contracts"

export type CustomShape = "point" | "polyline" | "polygon"

/** What the kind tools hand over: the clicked points plus the kind's options as set in the panel. */
export interface DrawOptions {
  readonly customShape: CustomShape
  readonly customLabel: string
  readonly regionFlag: RegionFlag
}

export const DEFAULT_OPTIONS: DrawOptions = { customShape: "point", customLabel: "marker", regionFlag: "walkable" }

/** Clicks the kind needs before a record exists; `"many"` ends with Finish. A custom feature depends on its shape. */
export const clicksNeeded = (kind: MetadataKind, shape: CustomShape): number | "many" =>
  kind === "walkableRegion" ? "many"
  : kind === "navLink" ? 2
  : kind === "custom" ? (shape === "point" ? 1 : "many")
  : 1

export const minPoints = (kind: MetadataKind, shape: CustomShape): number =>
  kind === "walkableRegion" || (kind === "custom" && shape === "polygon") ? 3 : kind === "custom" && shape === "polyline" ? 2 : 1

const mean = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)

/** A new `proposed` record from clicked points, or `undefined` when there are too few. The id is supplied by the caller. */
export const buildRecord = (kind: MetadataKind, id: string, points: ReadonlyArray<Vec3>, o: DrawOptions): MetadataRecord | undefined => {
  if (points.length < minPoints(kind, o.customShape)) return undefined
  const common = { id, status: "proposed", provenance: {} } as const
  switch (kind) {
    case "walkableRegion": return { ...common, kind, ring: points, floorZ: Math.round(mean(points.map((p) => p[2]))), flag: o.regionFlag }
    case "creepCamp": return { ...common, kind, position: points[0]! }
    case "sinnersSacrifice": return { ...common, kind, position: points[0]! }
    case "healingOrb": return { ...common, kind, position: points[0]! }
    case "navLink": return { ...common, kind, from: points[0]!, to: points[1]!, linkKind: "zipline" satisfies NavLinkKind, bidirectional: false }
    case "custom": return {
      ...common, kind, label: o.customLabel || "marker",
      geometry: o.customShape === "point" ? { type: "point", at: points[0]! }
        : o.customShape === "polyline" ? { type: "polyline", points } : { type: "polygon", ring: points }
    }
  }
}

let counter = 0
/** `camp-1a2b3c`: kind prefix plus time and a counter, unique across reloads without a server. */
export const newDraftId = (kind: MetadataKind): string =>
  `${kind}-${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
