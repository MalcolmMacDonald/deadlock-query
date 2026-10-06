import { normalize, type CameraMode, type CameraPose } from "./camera.ts"

export interface HashCamera {
  readonly mode: CameraMode
  readonly pose: CameraPose
}

const MODES: ReadonlyArray<CameraMode> = ["map", "orbit", "fly"]
const r = (n: number, dp: number) => String(Math.round(n * 10 ** dp) / 10 ** dp)

/** `cam=<mode>:<tx>,<ty>,<tz>,<yaw>,<pitch>,<distance>` */
export const encodeCamera = ({ mode, pose }: HashCamera): string =>
  `cam=${mode}:${[r(pose.target[0], 1), r(pose.target[1], 1), r(pose.target[2], 1), r(pose.yaw, 4), r(pose.pitch, 4), r(pose.distance, 1)].join(",")}`

/** Parses `#cam=...` (other hash params are ignored); returns undefined when absent or malformed. */
export const decodeCamera = (hash: string): HashCamera | undefined => {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("cam")
  if (!raw) return undefined
  const [mode, nums] = raw.split(":")
  if (!MODES.includes(mode as CameraMode) || !nums) return undefined
  const v = nums.split(",").map(Number)
  if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) return undefined
  const [tx, ty, tz, yaw, pitch, distance] = v as [number, number, number, number, number, number]
  return { mode: mode as CameraMode, pose: normalize({ target: [tx, ty, tz], yaw, pitch, distance }) }
}
