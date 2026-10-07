import type { Manifest, MetadataRecord } from "@deadlock-query/contracts"
import type { CollisionProbe } from "@deadlock-query/map-metadata"
import { Raycaster } from "@deadlock-query/spatial-core"

// Slightly off the vertical so a ray does not run along a triangle edge or diagonal and count one surface twice.
const TILT = [0.0123, 0.0071] as const
const UP = [TILT[0], TILT[1], 1] as const
const DOWN = [TILT[0], TILT[1], -1] as const

/**
 * A `CollisionProbe` over a collision BVH. `groundZ` is the first surface hit by a ray cast straight down. `insideSolid`
 * is conservative: a point only counts as inside when rays up and down both cross an odd number of surfaces, so an
 * open (non-watertight) collision mesh cannot make a good point look buried.
 */
export const probeFromRaycaster = (rc: Pick<Raycaster, "raycastFirst" | "raycastAll">): CollisionProbe => ({
  groundZ: (x, y, zFrom) => rc.raycastFirst([x, y, zFrom], [0, 0, -1], { backfaces: true })?.point[2],
  insideSolid: (p) => rc.raycastAll(p, UP, { backfaces: true }).length % 2 === 1 && rc.raycastAll(p, DOWN, { backfaces: true }).length % 2 === 1,
})

export interface MetadataSupport {
  readonly manifest: Pick<Manifest, "mapName" | "gameBuildId" | "bounds">
  readonly collision: CollisionProbe | undefined
  readonly accepted: ReadonlyArray<MetadataRecord>
}

type Fetch = (url: string) => Promise<Response>

/**
 * What the metadata editor needs from the published bundle: the manifest (bounds, map, build), a collision probe from
 * `baked/collision.bvh` when the bundle has one, and the accepted records of `metadata.bundle.json` beside the manifest
 * when it exists. Anything missing degrades the editor's checks instead of failing it.
 */
export const loadMetadataSupport = async (manifestUrl: string, fetcher: Fetch = (u) => fetch(u)): Promise<MetadataSupport | undefined> => {
  const base = new URL(manifestUrl, globalThis.location?.href)
  const manifestRes = await fetcher(base.href)
  if (!manifestRes.ok) return undefined
  const manifest = (await manifestRes.json()) as Manifest
  const bvhFile = manifest.baked?.bvh?.file
  const [collision, accepted] = await Promise.all([
    bvhFile
      ? fetcher(new URL(bvhFile, base).href)
          .then(async (r) => (r.ok ? probeFromRaycaster(Raycaster.deserialize(await r.arrayBuffer())) : undefined))
          .catch(() => undefined)
      : undefined,
    fetcher(new URL("metadata.bundle.json", base).href)
      .then(async (r) => {
        if (!r.ok) return []
        const json = (await r.json()) as { records?: ReadonlyArray<MetadataRecord> }
        return (json.records ?? []).filter((x) => x.status === "accepted")
      })
      .catch(() => []),
  ])
  return { manifest, collision, accepted }
}
