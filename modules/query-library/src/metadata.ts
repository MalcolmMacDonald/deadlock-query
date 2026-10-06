import { MapEntity, type EntityKind } from "./entities.ts"
import { Vec3 } from "./Vec3.ts"
import { UNITS_PER_METER } from "./units.ts"
import type { NavInput, SpatialInput } from "./spatial.ts"

/** Who submitted and who reviewed a metadata record (self-declared, unverified). @category Metadata */
export interface RecordProvenance {
  readonly submitter?: { readonly name: string; readonly github?: string }
  readonly submissionId?: string
  readonly submittedAt?: string
  readonly reviewer?: string
  readonly reviewedAt?: string
  readonly comment?: string
}

type Point = readonly [number, number, number]

interface RecordBase {
  readonly id: string
  readonly status: "proposed" | "accepted" | "rejected" | "stale"
  readonly provenance: RecordProvenance
  readonly name?: string
  readonly note?: string
}

/**
 * Structural shape of a contracts `MetadataRecord`, so `dist/*.d.ts` never imports contracts.
 * Only `status: "accepted"` records are ever used.
 * @category Metadata
 */
export type MetadataRecordInput =
  | (RecordBase & { readonly kind: "walkableRegion"; readonly ring: ReadonlyArray<Point>; readonly floorZ: number; readonly flag: "walkable" | "noGo" | "interior" | "water"; readonly costMultiplier?: number })
  | (RecordBase & { readonly kind: "creepCamp"; readonly position: Point; readonly tier?: "weak" | "medium" | "strong" })
  | (RecordBase & { readonly kind: "sinnersSacrifice"; readonly position: Point })
  | (RecordBase & { readonly kind: "healingOrb"; readonly position: Point; readonly respawnSeconds?: number })
  | (RecordBase & { readonly kind: "navLink"; readonly from: Point; readonly to: Point; readonly linkKind: string; readonly bidirectional: boolean; readonly cost?: number })
  | (RecordBase & { readonly kind: "custom"; readonly label: string })

/** A loaded `metadata.bundle.json` (structural match for contracts `MetadataBundle`). @category Metadata */
export interface MetadataInput {
  readonly gameBuildId: string
  readonly mapName: string
  readonly records: ReadonlyArray<MetadataRecordInput>
}

/** Navmesh overrides in spatial-core's polygon-index form. @category Navigation */
export interface NavOverridesLike {
  readonly blockedPolys?: readonly number[]
  readonly addedLinks?: ReadonlyArray<{ readonly from: Point; readonly to: Point; readonly kind: string; readonly bidirectional?: boolean }>
  readonly costMultipliers?: Readonly<Record<number, number>>
}

/** A navmesh that can take overrides (spatial-core `NavMesh`); needed for metadata nav records. @category Navigation */
export interface OverridableNavMeshLike {
  readonly polyCount: number
  centroid(poly: number): Point
  withOverrides(o: NavOverridesLike): NavInput["mesh"]
}

/** What happened to one metadata record. @category Metadata */
export interface MetadataOutcome {
  readonly id: string
  readonly kind: MetadataRecordInput["kind"]
  readonly applied: boolean
  /** Why a record was not applied, or a note about how it was. */
  readonly detail?: string
  readonly provenance: RecordProvenance
}

/**
 * What the metadata merge did (`map.metadata`): one outcome per accepted record, in bundle order.
 * @category Metadata
 */
export interface MetadataReport {
  /** Whether a metadata bundle was supplied and matched the map build. */
  readonly loaded: boolean
  readonly gameBuildId: string | undefined
  readonly outcomes: ReadonlyArray<MetadataOutcome>
  /** Problems with the bundle as a whole (build or map mismatch). */
  readonly warnings: ReadonlyArray<string>
}

/** Tunables of the merge (from `MapSettings`). */
export interface MergeSettings {
  readonly dedupeRadius: number
  readonly regionZTolerance: number
}

const EMPTY: MetadataReport = { loaded: false, gameBuildId: undefined, outcomes: [], warnings: [] }

const insideXY = (ring: ReadonlyArray<Point>, x: number, y: number): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

const ENTITY_KINDS = { creepCamp: "creepCamp", sinnersSacrifice: "sinnersSacrifice", healingOrb: "healingOrb" } as const satisfies Record<string, EntityKind>

/** @internal Merge accepted metadata into the extractor's entities and the navmesh. */
export const mergeMetadata = (
  mapName: string, gameBuildId: string, extractor: ReadonlyArray<MapEntity>,
  metadata: MetadataInput | undefined, spatial: SpatialInput | undefined, settings: MergeSettings
): { entities: ReadonlyArray<MapEntity>; spatial: SpatialInput | undefined; report: MetadataReport } => {
  if (!metadata) return { entities: [], spatial, report: EMPTY }
  const warnings: string[] = []
  if (metadata.gameBuildId !== gameBuildId) warnings.push(`metadata is for game build "${metadata.gameBuildId}" but the map is "${gameBuildId}": ignored`)
  if (metadata.mapName !== mapName) warnings.push(`metadata is for map "${metadata.mapName}" but the map is "${mapName}": ignored`)
  if (warnings.length) return { entities: [], spatial, report: { loaded: false, gameBuildId: metadata.gameBuildId, outcomes: [], warnings } }

  const outcomes: MetadataOutcome[] = []
  const done = (r: MetadataRecordInput, applied: boolean, detail?: string) =>
    outcomes.push({ id: r.id, kind: r.kind, applied, ...(detail === undefined ? {} : { detail }), provenance: r.provenance })

  const added: MapEntity[] = []
  const blocked = new Set<number>()
  const mult: Record<number, number> = {}
  const links: Array<NonNullable<NavOverridesLike["addedLinks"]>[number]> = []
  const nav = spatial?.nav
  const mesh = nav?.mesh as (NavInput["mesh"] & Partial<OverridableNavMeshLike>) | undefined
  const overridable = mesh && typeof mesh.withOverrides === "function" && typeof mesh.centroid === "function" && typeof mesh.polyCount === "number"
  const linkSpeeds = nav?.linkSpeeds ?? { zipline: 15 * UNITS_PER_METER }

  for (const r of metadata.records) {
    if (r.status !== "accepted") continue
    switch (r.kind) {
      case "creepCamp": case "sinnersSacrifice": case "healingOrb": {
        const kind = ENTITY_KINDS[r.kind]
        const at = new Vec3(...r.position)
        const twin = r.kind === "sinnersSacrifice" ? undefined : extractor.find((e) => e.kind === kind && e.position.distanceTo(at) <= settings.dedupeRadius)
        if (twin) { done(r, false, `duplicate of extractor entity ${twin.id} (within ${settings.dedupeRadius} units); the extractor's data wins`); break }
        const properties: Record<string, unknown> = { source: "metadata" }
        if (r.name !== undefined) properties.name = r.name
        if (r.note !== undefined) properties.note = r.note
        if (r.kind === "creepCamp" && r.tier !== undefined) properties.tier = r.tier
        if (r.kind === "healingOrb" && r.respawnSeconds !== undefined) properties.respawnSeconds = r.respawnSeconds
        added.push(new MapEntity(`metadata:${r.id}`, `metadata:${r.kind}`, kind, at, undefined, undefined, undefined, properties, "metadata", r.provenance))
        done(r, true)
        break
      }
      case "walkableRegion": {
        if (r.flag === "interior" || r.flag === "water") { done(r, false, `"${r.flag}" regions only tag the surface; they do not change navigation`); break }
        if (!overridable) { done(r, false, nav ? "the navmesh does not support overrides (needs withOverrides/centroid/polyCount)" : "no navmesh loaded"); break }
        if (r.flag === "walkable" && r.costMultiplier === undefined) { done(r, false, "adding walkable ground needs navmesh support for added polygons (request to spatial-core); give the region a costMultiplier to retune existing ground"); break }
        let n = 0
        for (let p = 0; p < mesh.polyCount!; p++) {
          const c = mesh.centroid!(p)
          if (Math.abs(c[2] - r.floorZ) > settings.regionZTolerance || !insideXY(r.ring, c[0], c[1])) continue
          n++
          if (r.flag === "noGo") blocked.add(p)
          else mult[p] = (mult[p] ?? 1) * r.costMultiplier!
        }
        done(r, n > 0, n > 0 ? `${r.flag === "noGo" ? "blocked" : "re-costed"} ${n} polygons` : `matches no navmesh polygon within ${settings.regionZTolerance} units of floorZ ${r.floorZ}`)
        break
      }
      case "navLink": {
        if (!overridable) { done(r, false, nav ? "the navmesh does not support overrides (needs withOverrides/centroid/polyCount)" : "no navmesh loaded"); break }
        if (!(r.linkKind in linkSpeeds)) { done(r, false, `no travel speed for link kind "${r.linkKind}"; set nav.linkSpeeds.${r.linkKind}`); break }
        links.push({ from: r.from, to: r.to, kind: r.linkKind, bidirectional: r.bidirectional })
        done(r, true, r.cost === undefined ? undefined : "cost is ignored: link time is length / speed of its kind")
        break
      }
      case "custom": done(r, false, "custom records are not entities; read them from the bundle directly"); break
    }
  }

  let out = spatial
  if (nav && overridable && (blocked.size || links.length || Object.keys(mult).length)) {
    const patched = mesh.withOverrides!({
      ...(blocked.size ? { blockedPolys: [...blocked].sort((a, b) => a - b) } : {}),
      ...(links.length ? { addedLinks: links } : {}),
      ...(Object.keys(mult).length ? { costMultipliers: mult } : {}),
    })
    out = { ...spatial!, nav: { ...nav, mesh: patched } }
  }
  return { entities: added, spatial: out, report: { loaded: true, gameBuildId, outcomes, warnings } }
}
