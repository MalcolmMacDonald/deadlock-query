import { existsSync, readFileSync } from "node:fs"
import type { Vec3 } from "@deadlock-query/contracts"
import { rotation, type InteriorVolume } from "./interior.ts"
import type { NavLink } from "@deadlock-query/spatial-core"

/**
 * Climb ropes (`citadel_trigger_climb_rope`) are trigger volumes with a per-entity model, like the interior volumes: `extract`
 * exports each model's bounds as a box in the entity's frame (same file shape as `interior-volumes.json`). The rope runs along
 * the box's longest local axis, so a rope is one two-way link between the centres of the box's two end faces.
 */
export const CLIMB_ROPES_FILE = "collision/climb-ropes.json"
export const CLIMB_ROPE_KIND = "climbRope"
/** A box shorter than this along its longest axis is not a rope (a stray trigger). */
export const ROPE_MIN_LENGTH = 96

export const ropeLinks = (volumes: ReadonlyArray<InteriorVolume>): NavLink[] =>
  volumes.flatMap((v) => {
    const size = [0, 1, 2].map((i) => v.localMax[i]! - v.localMin[i]!)
    const axis = size.indexOf(Math.max(...size))
    if (size[axis]! < ROPE_MIN_LENGTH) return []
    const r = rotation(v.angles)
    const end = (side: number): Vec3 => {
      const local = [0, 1, 2].map((i) => (i === axis ? (side ? v.localMax[i]! : v.localMin[i]!) : (v.localMin[i]! + v.localMax[i]!) / 2))
      return [0, 1, 2].map((row) => v.origin[row]! + r[row * 3]! * local[0]! + r[row * 3 + 1]! * local[1]! + r[row * 3 + 2]! * local[2]!) as unknown as Vec3
    }
    return [{ from: end(0), to: end(1), kind: CLIMB_ROPE_KIND, bidirectional: true }]
  })

export const loadRopeVolumes = (path: string): InteriorVolume[] =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { volumes: InteriorVolume[] }).volumes : []
