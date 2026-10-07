import { expect, test } from "bun:test"
import * as THREE from "three"
import { Effect } from "effect"
import { MockMapDataService, worldToThree } from "@deadlock-query/contracts"
import {
  FOCUS_MIN_DISTANCE, MAX_PITCH, buildScene, decodeCamera, encodeCamera, eyeOf, fly, frameBounds, frameEntities, frameSelection, glbToThreeMatrix, loadViewerData,
  keyboardStep, pan, pinchDelta, poseFromEye, rotate, switchMode, zoom, WORLD_TO_THREE
} from "../src/index.ts"

const close = (a: ReadonlyArray<number>, b: ReadonlyArray<number>, dp = 3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, dp))

test("frameBounds looks top-down at the box center", () => {
  const p = frameBounds([-4000, -3000, 0], [4000, 3000, 600])
  expect(p.pitch).toBe(-MAX_PITCH)
  close(p.target, [0, 0, 300])
  expect(eyeOf(p)[2]).toBeGreaterThan(p.target[2])
})

test("frameEntities ignores stray outliers and the origin, and gives up on a handful of points", () => {
  const grid: Array<[number, number, number]> = []
  for (let i = 0; i < 100; i++) grid.push([(i % 10) * 800 - 4000, Math.floor(i / 10) * 600 - 3000, 100])
  const wide = frameBounds([-4000, -3000, 100], [3200, 2400, 100])
  const home = frameEntities([...grid, [0, 0, 0], [40000, -30000, 20000]])!
  expect(home.pitch).toBe(-MAX_PITCH)
  expect(home.distance).toBeLessThan(frameBounds([-4000, -3000, 0], [40000, 0, 20000]).distance / 2)
  expect(home.distance).toBeGreaterThan(wide.distance * 0.9)
  expect(frameEntities(grid.slice(0, 5))).toBeUndefined()
})

test("poseFromEye inverts eyeOf", () => {
  const p = poseFromEye([100, 200, 900], [0, 0, 0])
  close(eyeOf(p), [100, 200, 900], 2)
})

test("map pan: dragging right moves the target left (scene follows pointer)", () => {
  const p = frameBounds([-1000, -1000, 0], [1000, 1000, 0])
  const q = pan(p, 100, 0, 800)
  expect(q.target[0]).toBeLessThan(p.target[0])
  expect(q.target[2]).toBe(p.target[2])
})

test("orbit keeps the target; fly look keeps the eye", () => {
  const p = frameBounds([-1000, -1000, 0], [1000, 1000, 0])
  const orbit = rotate(p, 0.4, 0.2, "target")
  expect(orbit.target).toEqual(p.target)
  const look = rotate(switchMode(p, "fly"), 0.4, 0.3, "eye")
  close(eyeOf(look), eyeOf(p), 2)
})

test("zoom clamps distance; fly moves along the look direction", () => {
  const p = frameBounds([-1000, -1000, 0], [1000, 1000, 0])
  expect(zoom(p, 1e-9).distance).toBeGreaterThan(0)
  const f = fly({ ...p, pitch: 0, yaw: 0 }, 1, 0, 0, 100)
  close(f.target, [p.target[0] + 100, p.target[1], p.target[2]])
})

test("hash round-trips mode and pose, rejects garbage", () => {
  const cam = { mode: "orbit" as const, pose: { target: [10.5, -20.2, 30] as const, yaw: 1.2345, pitch: -0.5, distance: 1234.5 } }
  const back = decodeCamera("#foo=1&" + encodeCamera(cam))!
  expect(back.mode).toBe("orbit")
  close(back.pose.target, cam.pose.target, 1)
  expect(back.pose.yaw).toBeCloseTo(1.2345, 3)
  expect(decodeCamera("")).toBeUndefined()
  expect(decodeCamera("#cam=bogus:1,2,3,4,5,6")).toBeUndefined()
  expect(decodeCamera("#cam=map:1,2,3")).toBeUndefined()
})

test("WORLD_TO_THREE matches contracts worldToThree", () => {
  const m = new THREE.Matrix4().fromArray([...WORLD_TO_THREE])
  const w: [number, number, number] = [3, 5, 7]
  const v = new THREE.Vector3(...w).applyMatrix4(m)
  close([v.x, v.y, v.z], worldToThree(w))
})

test("fixture render tile lands inside manifest bounds after glbToWorld + worldToThree", async () => {
  const data = await Effect.runPromise(loadViewerData.pipe(Effect.provide(MockMapDataService)))
  const root = await buildScene(data)
  root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  root.children.filter((c) => c instanceof THREE.Group && !(c instanceof THREE.Light) && c.children.length > 0).forEach((c) => box.expandByObject(c))
  expect(box.isEmpty()).toBe(false)
  const { min, max } = data.manifest.bounds
  const lo = worldToThree(min), hi = worldToThree(max)
  const eps = 1
  expect(box.min.x).toBeGreaterThanOrEqual(Math.min(lo[0], hi[0]) - eps)
  expect(box.max.x).toBeLessThanOrEqual(Math.max(lo[0], hi[0]) + eps)
  expect(box.min.y).toBeGreaterThanOrEqual(Math.min(lo[1], hi[1]) - eps)
  expect(box.max.y).toBeLessThanOrEqual(Math.max(lo[1], hi[1]) + eps)
  expect(box.min.z).toBeGreaterThanOrEqual(Math.min(lo[2], hi[2]) - eps)
  expect(box.max.z).toBeLessThanOrEqual(Math.max(lo[2], hi[2]) + eps)
  expect(glbToThreeMatrix(data.manifest.coordinateSystem.glbToWorld).elements.length).toBe(16)
})

test("frameSelection centres on the selection's bounds, keeps the view direction and never hugs a lone point", () => {
  const pose = { target: [0, 0, 0] as const, yaw: 1, pitch: -0.7, distance: 5000 }
  expect(frameSelection(pose, [])).toBeUndefined()
  const one = frameSelection(pose, [[100, 200, 30]])!
  expect(one.target).toEqual([100, 200, 30])
  expect(one.distance).toBe(FOCUS_MIN_DISTANCE)
  expect([one.yaw, one.pitch]).toEqual([1, -0.7])
  const many = frameSelection(pose, [[0, 0, 0], [2000, 0, 0], [0, 1000, 400]])!
  close(many.target, [1000, 500, 200])
  // The bounding sphere (radius ~1.1k) fits inside the vertical field of view.
  expect(many.distance).toBeGreaterThan(Math.hypot(2000, 1000, 400) / 2 / Math.sin((50 * Math.PI) / 360))
})

test("keyboardStep: arrows pan in Map, turn in Orbit and Fly, plus/minus zoom, Shift triples, other keys do nothing", () => {
  const p = { target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: -1, distance: 1000 }
  const right = keyboardStep(p, "map", "ArrowRight", 800)
  const drag = pan(p, -60, 0, 800)
  close(right.target, drag.target)
  expect(keyboardStep(p, "map", "ArrowRight", 800, true).target[1]).toBeCloseTo(right.target[1]! * 3, 3)
  expect(keyboardStep(p, "orbit", "ArrowLeft", 800).yaw).toBeGreaterThan(p.yaw)
  expect(keyboardStep(p, "orbit", "ArrowLeft", 800).target).toEqual(p.target)
  expect(keyboardStep(p, "fly", "ArrowLeft", 800).target).not.toEqual(p.target)
  expect(keyboardStep(p, "map", "+", 800).distance).toBeLessThan(p.distance)
  expect(keyboardStep(p, "orbit", "-", 800).distance).toBeGreaterThan(p.distance)
  expect(keyboardStep(p, "fly", "+", 800)).toBe(p)
  expect(keyboardStep(p, "map", "x", 800)).toBe(p)
})

test("pinchDelta: spreading fingers scales up, moving both moves the midpoint, a collapsed pair is scale 1", () => {
  const a = [{ x: 0, y: 0 }, { x: 100, y: 0 }] as const
  const spread = pinchDelta(a, [{ x: -50, y: 0 }, { x: 150, y: 0 }])
  expect(spread.scale).toBeCloseTo(2)
  expect(spread.dx).toBeCloseTo(0)
  const moved = pinchDelta(a, [{ x: 10, y: 20 }, { x: 110, y: 20 }])
  expect(moved).toEqual({ scale: 1, dx: 10, dy: 20 })
  expect(pinchDelta([{ x: 5, y: 5 }, { x: 5, y: 5 }], a).scale).toBe(1)
})
