import { expect, test } from "bun:test"
import type { Vec3 } from "@deadlock-query/contracts"
import { DEFAULT_SNAP, SnapState, snap, snapCandidates, type SurfaceHit } from "../src/index.ts"

/** Orthographic top-down projection: 1 world unit = 1 px, world (x, y) -> pixel (x, y). */
const project = (p: Vec3): readonly [number, number] => [p[0], p[1]]

const hit = (point: Vec3, triangle?: SurfaceHit["triangle"]): SurfaceHit => ({ point, normal: [0, 0, 1], distance: 1, triangle })
const tri: SurfaceHit["triangle"] = [[100, 100, 5], [200, 100, 5], [100, 200, 5]]

const input = (over: Partial<Parameters<typeof snap>[0]>) => ({
  cursor: [150, 150] as const, project, candidates: [] as Vec3[], settings: DEFAULT_SNAP, ...over
})

test("priority: feature vertex, then triangle vertex, then surface, then plane", () => {
  const h = hit([103, 103, 5], tri)
  expect(snap(input({ hit: h, cursor: [104, 104], candidates: [[108, 104, 9]] }))).toEqual({ point: [108, 104, 9], kind: "feature" })
  expect(snap(input({ hit: h, cursor: [104, 104] }))).toEqual({ point: [100, 100, 5], kind: "vertex" })
  expect(snap(input({ hit: hit([150, 150, 5], tri) }))).toEqual({ point: [150, 150, 5], kind: "surface" })
  expect(snap(input({ plane: [1, 2, 3] }))).toEqual({ point: [1, 2, 3], kind: "plane" })
  expect(snap(input({}))).toBeUndefined()
})

test("radius is in screen pixels and the nearest vertex wins", () => {
  const c: Vec3[] = [[160, 150, 0], [153, 150, 1], [150, 170, 2]]
  expect(snap(input({ candidates: c, radiusPx: 12 }))?.point).toEqual([153, 150, 1])
  expect(snap(input({ candidates: [[170, 150, 0]], radiusPx: 12, plane: [0, 0, 0] }))?.kind).toBe("plane")
  // Behind the camera (project returns undefined) never snaps.
  expect(snap({ ...input({ candidates: [[150, 150, 0]] }), project: () => undefined })).toBeUndefined()
})

test("settings switch each snap off", () => {
  const h = hit([103, 103, 5], tri)
  const base = { hit: h, cursor: [104, 104] as const, candidates: [[105, 104, 9]] as Vec3[], plane: [0, 0, 0] as Vec3 }
  expect(snap(input({ ...base, settings: { ...DEFAULT_SNAP, features: false } }))?.kind).toBe("vertex")
  expect(snap(input({ ...base, settings: { ...DEFAULT_SNAP, features: false, vertices: false } }))?.kind).toBe("surface")
  // Surface off: vertices still snap, otherwise the point goes on the plane.
  expect(snap(input({ ...base, settings: { surface: false, vertices: true, features: false } }))?.kind).toBe("vertex")
  expect(snap(input({ ...base, cursor: [150, 150], settings: { surface: false, vertices: true, features: false } }))?.kind).toBe("plane")
})

test("snapCandidates gathers visible layers' vertices, extra points first, and honours skip", () => {
  const layers = [
    ["ann.lines", { style: {}, features: [{ type: "polyline" as const, points: [[0, 0, 0], [1, 1, 1]] as Vec3[] }, { type: "polygon" as const, ring: [[5, 5, 5], [6, 6, 6], [7, 7, 7]] as Vec3[] }] }],
    ["q", { style: {}, features: [{ type: "point" as const, at: [9, 9, 9] as Vec3 }] }]
  ] as const
  expect(snapCandidates(layers, [[-1, -1, -1]]).length).toBe(1 + 2 + 3 + 1)
  expect(snapCandidates(layers)[0]).toEqual([0, 0, 0])
  const skipped = snapCandidates(layers, [], (id) => id === "ann.lines:0")
  expect(skipped).toHaveLength(4)
  expect(skipped.some((p) => p[0] === 0)).toBe(false)
})

test("SnapState notifies only on change", () => {
  const s = new SnapState()
  let n = 0
  const off = s.subscribe(() => n++)
  s.set({ features: true })
  expect(n).toBe(0)
  s.set({ features: false })
  expect(n).toBe(1)
  expect(s.settings).toEqual({ surface: true, vertices: true, features: false })
  off()
  s.set({ surface: false })
  expect(n).toBe(1)
})
