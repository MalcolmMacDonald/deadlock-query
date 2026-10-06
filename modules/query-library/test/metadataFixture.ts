import { buildMiniMap, makeMetadataBundle, type MetadataRecord } from "@deadlock-query/contracts"
import { NavMesh } from "@deadlock-query/spatial-core"
import { MapContext, type NavMeshLike, type RaycasterLike } from "../src/index.ts"
import { SPEED, floor, grid } from "./navFixture.ts"

const mini = buildMiniMap()

export const provenance = (name: string) => ({
  submitter: { name, github: name.toLowerCase() },
  submissionId: `sub-${name.toLowerCase()}`,
  submittedAt: "2026-10-01T10:00:00Z",
  reviewer: "Malcolm",
  reviewedAt: "2026-10-02T10:00:00Z",
}) as const

type Common = { id: string; status?: "proposed" | "accepted" | "rejected" | "stale"; by?: string }
const common = (c: Common) => ({ id: c.id, status: c.status ?? "accepted", provenance: provenance(c.by ?? "Alice") })

export const camp = (c: Common & { at: [number, number, number]; tier?: "weak" | "medium" | "strong" }): MetadataRecord =>
  ({ ...common(c), kind: "creepCamp", position: c.at, ...(c.tier ? { tier: c.tier } : {}) })
export const sacrifice = (c: Common & { at: [number, number, number] }): MetadataRecord =>
  ({ ...common(c), kind: "sinnersSacrifice", position: c.at })
export const orb = (c: Common & { at: [number, number, number] }): MetadataRecord =>
  ({ ...common(c), kind: "healingOrb", position: c.at })
export const region = (c: Common & { x: [number, number]; y: [number, number]; floorZ?: number; flag: "walkable" | "noGo" | "interior" | "water"; costMultiplier?: number }): MetadataRecord => {
  const z = c.floorZ ?? 0
  return { ...common(c), kind: "walkableRegion", ring: [[c.x[0], c.y[0], z], [c.x[1], c.y[0], z], [c.x[1], c.y[1], z], [c.x[0], c.y[1], z]], floorZ: z, flag: c.flag, ...(c.costMultiplier ? { costMultiplier: c.costMultiplier } : {}) }
}
export const link = (c: Common & { from: [number, number, number]; to: [number, number, number]; linkKind: "zipline" | "jumpPad"; bidirectional?: boolean }): MetadataRecord =>
  ({ ...common(c), kind: "navLink", from: c.from, to: c.to, linkKind: c.linkKind, bidirectional: c.bidirectional ?? true })

/** The hand-computable 9x9 grid navmesh (see navFixture) plus metadata records. */
export const buildMetadataMap = (records: ReadonlyArray<MetadataRecord>, opts: { nav?: boolean; gameBuildId?: string; mapName?: string } = {}) =>
  MapContext.fromBundle({
    ...mini,
    metadata: makeMetadataBundle({ gameBuildId: opts.gameBuildId ?? mini.manifest.gameBuildId, mapName: opts.mapName ?? mini.manifest.mapName }, records),
    spatial: { raycaster: floor as RaycasterLike, ...(opts.nav === false ? {} : { nav: { mesh: NavMesh.fromPolygons(grid(), []) as NavMeshLike, heroSpeed: SPEED, linkSpeeds: { zipline: 5000 } } }) },
  })

/** Records used by the `@requires metadata` examples. */
export const exampleRecords: ReadonlyArray<MetadataRecord> = [
  camp({ id: "c-far", at: [3000, 3000, 20], tier: "strong", by: "Alice" }),
  sacrifice({ id: "s-1", at: [-3000, 2000, 20], by: "Bob" }),
]
