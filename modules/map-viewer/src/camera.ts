import type { Vec3 } from "@deadlock-query/contracts"

export type CameraMode = "map" | "orbit" | "fly"

/**
 * Camera pose in canonical world space (Z-up). `target` is the point looked at, `distance` the
 * eye-to-target length, `yaw` is rotation about +Z (rad, 0 = looking along +X), `pitch` is
 * elevation of the look direction (negative looks down).
 */
export interface CameraPose {
  readonly target: Vec3
  readonly yaw: number
  readonly pitch: number
  readonly distance: number
}

export const MAX_PITCH = 1.55
export const MIN_DISTANCE = 20
export const MAX_DISTANCE = 100_000

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const lookDir = (yaw: number, pitch: number): Vec3 => [
  Math.cos(pitch) * Math.cos(yaw),
  Math.cos(pitch) * Math.sin(yaw),
  Math.sin(pitch)
]

export const eyeOf = (p: CameraPose): Vec3 => {
  const d = lookDir(p.yaw, p.pitch)
  return [p.target[0] - d[0] * p.distance, p.target[1] - d[1] * p.distance, p.target[2] - d[2] * p.distance]
}

export const normalize = (p: CameraPose): CameraPose => ({
  target: p.target,
  yaw: Math.atan2(Math.sin(p.yaw), Math.cos(p.yaw)),
  pitch: clamp(p.pitch, -MAX_PITCH, MAX_PITCH),
  distance: clamp(p.distance, MIN_DISTANCE, MAX_DISTANCE)
})

/** Pose from an eye position and a target (inverse of `eyeOf`). */
export const poseFromEye = (eye: Vec3, target: Vec3): CameraPose => {
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2]
  const distance = Math.hypot(dx, dy, dz) || 1
  return normalize({ target, yaw: Math.atan2(dy, dx), pitch: Math.asin(dz / distance), distance })
}

/** Switching modes keeps the eye and target; Map mode additionally snaps to top-down. */
export const switchMode = (pose: CameraPose, mode: CameraMode): CameraPose =>
  mode === "map" ? normalize({ ...pose, pitch: -MAX_PITCH }) : pose

/** Camera framing a world-space box top-down. */
export const frameBounds = (min: Vec3, max: Vec3, fovDeg = 50, aspect = 1.6): CameraPose => {
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const halfH = Math.max((max[1] - min[1]) / 2, (max[0] - min[0]) / 2 / aspect)
  const distance = halfH / Math.tan((fovDeg * Math.PI) / 360) * 1.1 + (max[2] - min[2]) / 2
  return normalize({ target, yaw: Math.PI / 2, pitch: -MAX_PITCH, distance })
}

/** Closest `frameSelection` gets to a single point: far enough to see the surroundings (Source units, a person is ~70 tall). */
export const FOCUS_MIN_DISTANCE = 300

/**
 * Pose centred on the bounding box of `points`, keeping the current viewing direction. The distance fits the box's
 * bounding sphere in the view with some margin, and never goes below `FOCUS_MIN_DISTANCE` so a lone point is not
 * hugged. `undefined` when there is nothing to frame.
 */
export const frameSelection = (pose: CameraPose, points: ReadonlyArray<Vec3>, fovDeg = 50): CameraPose | undefined => {
  if (points.length === 0) return undefined
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const p of points) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, p[i]!); max[i] = Math.max(max[i]!, p[i]!) }
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2
  const distance = Math.max(FOCUS_MIN_DISTANCE, (radius / Math.sin((fovDeg * Math.PI) / 360)) * 1.15)
  return normalize({ ...pose, target, distance })
}

/** Pan in the ground plane by screen-space pixel deltas (drag right moves the map right). */
export const pan = (pose: CameraPose, dxPx: number, dyPx: number, viewportHeight: number, fovDeg = 50): CameraPose => {
  const worldPerPx = (2 * pose.distance * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportHeight)
  const rightX = Math.sin(pose.yaw), rightY = -Math.cos(pose.yaw)
  const fwdX = Math.cos(pose.yaw), fwdY = Math.sin(pose.yaw)
  const t = pose.target
  return {
    ...pose,
    target: [
      t[0] - (rightX * dxPx - fwdX * dyPx) * worldPerPx,
      t[1] - (rightY * dxPx - fwdY * dyPx) * worldPerPx,
      t[2]
    ]
  }
}

/** Rotate about the target (orbit) or about the eye (fly look). */
export const rotate = (pose: CameraPose, dYaw: number, dPitch: number, about: "target" | "eye"): CameraPose => {
  const next = normalize({ ...pose, yaw: pose.yaw + dYaw, pitch: pose.pitch + dPitch })
  if (about === "target") return next
  const eye = eyeOf(pose)
  const d = lookDir(next.yaw, next.pitch)
  return { ...next, target: [eye[0] + d[0] * pose.distance, eye[1] + d[1] * pose.distance, eye[2] + d[2] * pose.distance] }
}

/** Exponential zoom; `factor` > 1 zooms out. */
export const zoom = (pose: CameraPose, factor: number): CameraPose => normalize({ ...pose, distance: pose.distance * factor })

/** Fly: move eye along forward/right/up by `amount` world units (each in -1..1), target follows. */
export const fly = (pose: CameraPose, forward: number, right: number, up: number, units: number): CameraPose => {
  const d = lookDir(pose.yaw, pose.pitch)
  const rx = Math.sin(pose.yaw), ry = -Math.cos(pose.yaw)
  const mx = (d[0] * forward + rx * right) * units
  const my = (d[1] * forward + ry * right) * units
  const mz = (d[2] * forward + up) * units
  return { ...pose, target: [pose.target[0] + mx, pose.target[1] + my, pose.target[2] + mz] }
}
