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

/**
 * Home view for a map: top-down on the middle 96% of the entities (2nd to 98th percentile per axis, so a few stray
 * entities far outside the playable area do not push the camera out), with some margin. `undefined` for fewer than
 * `MIN_FRAME_ENTITIES` positions, where the caller falls back to the manifest bounds.
 */
export const MIN_FRAME_ENTITIES = 20
export const frameEntities = (positions: ReadonlyArray<Vec3>, fovDeg = 50, aspect = 1.6): CameraPose | undefined => {
  const pts = positions.filter((p) => p[0] !== 0 || p[1] !== 0 || p[2] !== 0) // worldspawn and friends sit at the origin
  if (pts.length < MIN_FRAME_ENTITIES) return undefined
  const range = (axis: 0 | 1 | 2): [number, number] => {
    const v = pts.map((p) => p[axis]).sort((a, b) => a - b)
    return [v[Math.floor(v.length * 0.02)]!, v[Math.min(v.length - 1, Math.floor(v.length * 0.98))]!]
  }
  const [x0, x1] = range(0), [y0, y1] = range(1), [z0, z1] = range(2)
  const px = (x1 - x0) * 0.08, py = (y1 - y0) * 0.08
  return frameBounds([x0 - px, y0 - py, z0], [x1 + px, y1 + py, z1], fovDeg, aspect)
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

/** Two touch points in client pixels. */
export type TouchPair = readonly [{ readonly x: number; readonly y: number }, { readonly x: number; readonly y: number }]

/**
 * What a two-finger gesture did between two frames: `scale` is the pinch ratio (> 1 = fingers moved apart) and
 * `dx`/`dy` the movement of the midpoint in pixels. Zero-length pairs report scale 1.
 */
export const pinchDelta = (prev: TouchPair, next: TouchPair): { scale: number; dx: number; dy: number } => {
  const span = (p: TouchPair) => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y)
  const mid = (p: TouchPair) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 })
  const a = span(prev), b = span(next)
  const m0 = mid(prev), m1 = mid(next)
  return { scale: a > 1e-6 && b > 1e-6 ? b / a : 1, dx: m1.x - m0.x, dy: m1.y - m0.y }
}

/** Keys that move the camera without a pointer (arrows, plus/minus); anything else is not a camera key. */
export const CAMERA_KEYS: ReadonlyArray<string> = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_"]

/**
 * One keyboard step for the camera: arrows pan in Map mode, turn the view in Orbit (about the target) and Fly (about
 * the eye); `+`/`-` zoom in Map and Orbit. `big` (Shift) triples the step. Returns the pose unchanged for other keys.
 */
export const keyboardStep = (pose: CameraPose, mode: CameraMode, key: string, viewportHeight: number, big = false, fovDeg = 50): CameraPose => {
  const k = big ? 3 : 1
  const dx = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0
  const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0
  if (dx !== 0 || dy !== 0) {
    // Arrow right moves the view right, like dragging the map left.
    if (mode === "map") return pan(pose, -dx * 60 * k, -dy * 60 * k, viewportHeight, fovDeg)
    return rotate(pose, -dx * 0.08 * k, -dy * 0.08 * k, mode === "orbit" ? "target" : "eye")
  }
  if (mode === "fly") return pose
  if (key === "+" || key === "=") return zoom(pose, 1 / 1.25 ** k)
  if (key === "-" || key === "_") return zoom(pose, 1.25 ** k)
  return pose
}

/** Fly: move eye along forward/right/up by `amount` world units (each in -1..1), target follows. */
export const fly = (pose: CameraPose, forward: number, right: number, up: number, units: number): CameraPose => {
  const d = lookDir(pose.yaw, pose.pitch)
  const rx = Math.sin(pose.yaw), ry = -Math.cos(pose.yaw)
  const mx = (d[0] * forward + rx * right) * units
  const my = (d[1] * forward + ry * right) * units
  const mz = (d[2] * forward + up) * units
  return { ...pose, target: [pose.target[0] + mx, pose.target[1] + my, pose.target[2] + mz] }
}
