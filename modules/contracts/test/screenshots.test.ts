import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ScreenshotSet, decodeVersioned, makeScreenshotSet, poseError, shotsNear, validateScreenshotSet, type Shot } from "../src/index.ts"

const shot = (id: string, extra: Partial<Shot> = {}): Shot => ({
  id, requested: { position: [0, 0, 100], angles: [0, 90, 0] }, file: `${id}.jpg`, bytes: 10, sha256: "ab",
  width: 1920, height: 1080, capturedAt: "2026-10-06T12:00:00Z", ...extra
})
const meta = { gameBuildId: "25738777", mapName: "dl_midtown", fov: 90, hideHud: true }
const decode = (v: unknown) => Effect.runSync(Schema.decodeUnknownEffect(ScreenshotSet)(v))

test("a set decodes, round-trips and decodes as a versioned document", async () => {
  const set = makeScreenshotSet({ ...meta, tool: { name: "dlq-shoot", version: "0.1.0" } }, [
    shot("b", { group: "g1", thumbnail: "b.thumb.jpg", lookAt: [10, 0, 100], actual: { position: [0, 0, 100], angles: [0, 90, 0] } }), shot("a")
  ])
  expect(set.shots.map((s) => s.id)).toEqual(["a", "b"])
  expect(Effect.runSync(Schema.encodeEffect(ScreenshotSet)(decode(set)))).toEqual(set)
  expect((await Effect.runPromise(decodeVersioned(ScreenshotSet, 1)(set))).shots).toHaveLength(2)
  expect((await Effect.runPromise(decodeVersioned(ScreenshotSet, 1)({ ...set, schemaVersion: "2.0.0" }).pipe(Effect.result)))._tag).toBe("Failure")
})

test("schema rejects bad sizes, fov and poses", () => {
  const ok = makeScreenshotSet(meta, [shot("a")])
  expect(() => decode({ ...ok, fov: 0 })).toThrow()
  expect(() => decode({ ...ok, fov: 200 })).toThrow()
  expect(() => decode({ ...ok, shots: [shot("a", { width: 0 })] })).toThrow()
  expect(() => decode({ ...ok, shots: [shot("a", { height: 10.5 })] })).toThrow()
  expect(() => decode({ ...ok, shots: [{ ...shot("a"), requested: { position: [0, 0], angles: [0, 0, 0] } }] })).toThrow()
  expect(() => decode({ ...ok, shots: [shot("a", { capturedAt: "today" })] })).toThrow()
  expect(() => decode({ ...ok, hideHud: undefined })).toThrow()
})

test("poseError: units, wrap-around angles, absent without read-back", () => {
  expect(poseError(shot("a"))).toBeUndefined()
  expect(poseError(shot("a", { actual: { position: [3, 4, 100], angles: [0, 90, 0] } }))).toEqual({ position: 5, angle: 0 })
  const wrap = poseError(shot("a", { requested: { position: [0, 0, 0], angles: [0, 359, 0] }, actual: { position: [0, 0, 0], angles: [0, 1, 0] } }))!
  expect(wrap.angle).toBeCloseTo(2)
})

test("validateScreenshotSet: duplicates, tolerance, build and map", () => {
  const good = makeScreenshotSet(meta, [shot("a", { actual: { position: [1, 0, 100], angles: [0, 90.5, 0] } }), shot("b")])
  expect(validateScreenshotSet(good, { expect: { gameBuildId: "25738777", mapName: "dl_midtown" } })).toEqual([])
  const bad = makeScreenshotSet(meta, [
    shot("a"), shot("a", { file: "other.jpg" }), shot("c", { file: "a.jpg" }),
    shot("d", { file: "d.jpg", actual: { position: [100, 0, 100], angles: [0, 90, 0] } }),
    shot("e", { file: "e.jpg", actual: { position: [0, 0, 100], angles: [0, 120, 0] } })
  ])
  const errs = validateScreenshotSet(bad, { expect: { gameBuildId: "1", mapName: "x" } }).join("\n")
  expect(errs).toContain('duplicate shot id "a"')
  expect(errs).toContain('share the file "a.jpg"')
  expect(errs).toContain('shot "d": position is 100.0 units off')
  expect(errs).toContain('shot "e": angle is 30.0 degrees off')
  expect(errs).toContain('gameBuildId "25738777" is not "1"')
  expect(errs).toContain('mapName "dl_midtown" is not "x"')
  expect(validateScreenshotSet(bad, { positionTolerance: 200, angleTolerance: 45 }).join()).not.toContain("off the requested")
})

test("shotsNear uses the read-back pose, nearest first, ties by id", () => {
  const near = (id: string, x: number, actualX?: number) =>
    shot(id, { requested: { position: [x, 0, 0], angles: [0, 0, 0] }, ...(actualX !== undefined ? { actual: { position: [actualX, 0, 0], angles: [0, 0, 0] } } : {}) })
  const set = makeScreenshotSet(meta, [near("far", 500), near("b", 10), near("a", 10), near("moved", 400, 20)])
  expect(shotsNear(set, [0, 0, 0], 100).map((s) => s.id)).toEqual(["a", "b", "moved"])
  expect(shotsNear(set, [0, 0, 0], 5)).toEqual([])
})
