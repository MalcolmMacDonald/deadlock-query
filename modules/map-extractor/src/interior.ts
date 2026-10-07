import { existsSync, readFileSync } from "node:fs"
import type { Aabb, Entity, Mat4, Vec3 } from "@deadlock-query/contracts"
import { transformPoint } from "@deadlock-query/contracts"
import type { GltfInfo } from "./gltfInfo.ts"

/**
 * `interior` from the map's own `citadel_trigger_interior` volumes. world_physics has no buildings (see STATE.md), but every
 * volume entity names a per-entity model (`maps/<map>/entities/<name>.vmdl`) whose physics gives its shape. `extract` exports
 * those models and stores each volume as a box in the entity's own frame (the model's bounds in Source units), plus the
 * entity's origin and angles. A point is interior when it lies inside any box. A volume that is not a box is approximated by
 * its bounding box (an over-estimate); the real shapes still need checking against the game.
 */
export const INTERIOR_VOLUMES_FILE = "collision/interior-volumes.json"

export interface InteriorVolume {
  readonly id: string
  readonly model: string
  /** `interior_type` of the entity (0 and 1 occur on dl_midtown; the meaning is unknown, both count as interior). */
  readonly interiorType: number | undefined
  readonly origin: Vec3
  /** Source `angles` (pitch, yaw, roll, degrees). */
  readonly angles: Vec3
  /** Box in the entity's frame, Source units. */
  readonly localMin: Vec3
  readonly localMax: Vec3
}
export interface InteriorVolumesFile { readonly version: 1; readonly volumes: ReadonlyArray<InteriorVolume> }

/** Volume entities that name a model: `[entity, model resource name without `_c`]`. */
export const interiorModels = (entities: ReadonlyArray<Entity>): Array<{ entity: Entity; model: string }> =>
  entities.flatMap((entity) => {
    const m = entity.kind === "interior" ? entity.properties["model"] : undefined
    return typeof m === "string" && m.endsWith(".vmdl") ? [{ entity, model: m }] : []
  })

/** The entity's model bounds as a box in its own frame: the loaded bounds of the exported GLB mapped by its `glbToWorld`. */
export const localBox = (info: Pick<GltfInfo, "loadedBounds">, glbToWorld: Mat4): { min: Vec3; max: Vec3 } | undefined => {
  const b = info.loadedBounds as Aabb | undefined
  if (!b) return undefined
  let min: Vec3 | undefined, max: Vec3 | undefined
  for (let c = 0; c < 8; c++) {
    const p = transformPoint(glbToWorld, [c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2]])
    min = min ? (min.map((v, i) => Math.min(v, p[i]!)) as unknown as Vec3) : p
    max = max ? (max.map((v, i) => Math.max(v, p[i]!)) as unknown as Vec3) : p
  }
  return min && max ? { min, max } : undefined
}

const D2R = Math.PI / 180

/** Rows of R = Rz(yaw) Ry(pitch) Rx(roll), Source's angle order (forward = cp cy, cp sy, -sp). */
const rotation = ([pitch, yaw, roll]: Vec3): number[] => {
  const sp = Math.sin(pitch * D2R), cp = Math.cos(pitch * D2R), sy = Math.sin(yaw * D2R), cy = Math.cos(yaw * D2R), sr = Math.sin(roll * D2R), cr = Math.cos(roll * D2R)
  return [
    cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy,
    cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy,
    -sp, sr * cp, cr * cp
  ]
}

/** Containment test over a set of oriented boxes. */
export class InteriorVolumes {
  private readonly items: ReadonlyArray<{ v: InteriorVolume; r: number[] }>
  constructor(readonly volumes: ReadonlyArray<InteriorVolume>) { this.items = volumes.map((v) => ({ v, r: rotation(v.angles) })) }

  contains(x: number, y: number, z: number): boolean {
    for (const { v, r } of this.items) {
      const dx = x - v.origin[0], dy = y - v.origin[1], dz = z - v.origin[2]
      // local = R^T * d
      const lx = r[0]! * dx + r[3]! * dy + r[6]! * dz
      const ly = r[1]! * dx + r[4]! * dy + r[7]! * dz
      const lz = r[2]! * dx + r[5]! * dy + r[8]! * dz
      if (lx >= v.localMin[0] && lx <= v.localMax[0] && ly >= v.localMin[1] && ly <= v.localMax[1] && lz >= v.localMin[2] && lz <= v.localMax[2]) return true
    }
    return false
  }
}

export const loadInteriorVolumes = (path: string): InteriorVolumes | undefined => {
  if (!existsSync(path)) return undefined
  const f = JSON.parse(readFileSync(path, "utf8")) as InteriorVolumesFile
  return f.volumes.length > 0 ? new InteriorVolumes(f.volumes) : undefined
}
