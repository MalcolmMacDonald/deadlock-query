import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  DEFAULT_GLB_TO_WORLD, MockSelectionBus, MockViewerService, SelectionBus, ViewerService, makeMockViewerServiceWithTools, distance, metersToUnits,
  threeToWorld, transformPoint, unitsToMeters, worldToThree, type OverlayFeature, type Vec3
} from "../src/index.ts"

test("world <-> three round trips", () => {
  const p: Vec3 = [1, 2, 3]
  expect(threeToWorld(worldToThree(p))).toEqual(p)
})

test("glbToWorld maps glb Y-up to world Z-up", () => {
  expect(transformPoint(DEFAULT_GLB_TO_WORLD, [1, 2, 3])).toEqual([1, -3, 2])
})

test("unit conversion round trips and distance", () => {
  expect(metersToUnits(unitsToMeters(100))).toBeCloseTo(100)
  expect(distance([0, 0, 0], [3, 4, 0])).toBe(5)
})

test("mock selection bus stores selection", async () => {
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const bus = yield* SelectionBus
      yield* bus.select(["a"])
      return yield* bus.current
    }).pipe(Effect.provide(MockSelectionBus))
  )
  expect(out).toEqual(["a"])
})

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import {
  AnnotationDocument, EntitiesFile, Manifest, MockMapDataService, MapDataService, QueryResult, UnsupportedSchemaVersion,
  buildMiniMap, decodeVersioned, exportResult, makeAnnotationDocument, makeResult, sha256Hex, validateAnnotationDocument
} from "../src/index.ts"

const fixtureDir = join(import.meta.dir, "..", "fixtures", "mini-map")

test("sha256 matches node:crypto", () => {
  for (const s of ["", "abc", "x".repeat(1000)]) {
    const b = new TextEncoder().encode(s)
    expect(sha256Hex(b)).toBe(createHash("sha256").update(b).digest("hex"))
  }
})

test("mini map is deterministic and schema-valid", () => {
  const a = buildMiniMap(), b = buildMiniMap()
  expect(sha256Hex(a.collisionGlb)).toBe(sha256Hex(b.collisionGlb))
  Schema.decodeUnknownSync(Manifest)(a.manifest)
  Schema.decodeUnknownSync(EntitiesFile)({ schemaVersion: "1.0.0", entities: a.entities })
  Schema.decodeUnknownSync(QueryResult)(a.expectedGuardianOrbDistance)
  expect(a.entities.filter((e) => e.kind === "guardian")).toHaveLength(6)
  expect(a.entities.some((e) => e.kind === undefined)).toBe(true)
})

test("committed fixtures match the generator (run bun run gen:fixtures)", () => {
  const m = buildMiniMap()
  expect(existsSync(join(fixtureDir, "manifest.json"))).toBe(true)
  expect(JSON.parse(readFileSync(join(fixtureDir, "manifest.json"), "utf8"))).toEqual(m.manifest)
  expect(sha256Hex(new Uint8Array(readFileSync(join(fixtureDir, "collision/physics.glb"))))).toBe(sha256Hex(m.collisionGlb))
  expect(JSON.parse(readFileSync(join(fixtureDir, "expected/guardian-orb-distance.json"), "utf8")))
    .toEqual(m.expectedGuardianOrbDistance)
})

test("generated GLBs have a valid header", () => {
  const m = buildMiniMap()
  const dv = new DataView(m.collisionGlb.buffer)
  expect(dv.getUint32(0, true)).toBe(0x46546c67)
  expect(dv.getUint32(8, true)).toBe(m.collisionGlb.length)
})

test("decodeVersioned rejects wrong majors with an actionable error", async () => {
  const m = buildMiniMap().manifest
  const ok = await Effect.runPromise(decodeVersioned(Manifest, 1)(m))
  expect(ok.mapName).toBe("mini_map")
  const newer = await Effect.runPromise(Effect.flip(decodeVersioned(Manifest, 1)({ ...m, schemaVersion: "2.0.0" })))
  expect(newer).toBeInstanceOf(UnsupportedSchemaVersion)
  expect(newer.message).toContain("update this app")
  const older = await Effect.runPromise(Effect.flip(decodeVersioned(Manifest, 2)({ ...m, schemaVersion: "1.0.0" })))
  expect(older.message).toContain("re-run the extractor")
})

test("schema rejects malformed documents", () => {
  const m = buildMiniMap().manifest
  expect(() => Schema.decodeUnknownSync(Manifest)({ ...m, tier: "huge" })).toThrow()
  expect(() => Schema.decodeUnknownSync(Manifest)({ ...m, bounds: { min: [0, 0], max: [1, 1, 1] } })).toThrow()
  expect(() => Schema.decodeUnknownSync(Manifest)({ ...m, coordinateSystem: { ...m.coordinateSystem, glbToWorld: [1] } })).toThrow()
})

test("exportResult csv escapes, geojson emits features", () => {
  const r = makeResult(
    [{ name: "label", type: "string" }, { name: "at", type: "point" }, { name: "path", type: "polyline" }],
    [['a,"b"', [1, 2, 3], [[0, 0, 0], [1, 1, 1]]]]
  )
  expect(exportResult(r, "csv")).toBe('label,at,path\n"a,""b""","[1,2,3]","[[0,0,0],[1,1,1]]"\n')
  const gj = JSON.parse(exportResult(r, "geojson"))
  expect(gj.features).toHaveLength(2)
  expect(gj.features[0].geometry).toEqual({ type: "Point", coordinates: [1, 2, 3] })
  expect(gj.features[1].geometry.type).toBe("LineString")
  expect(gj.features[0].properties.label).toBe('a,"b"')
  expect(JSON.parse(exportResult(r, "json")).columns).toHaveLength(3)
})

test("mock map data service serves the fixture", async () => {
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* MapDataService
      const m = yield* svc.manifest
      const tile = yield* svc.loadTile(m.tiles[0]!.id)
      return { m, tile }
    }).pipe(Effect.provide(MockMapDataService))
  )
  expect(sha256Hex(out.tile)).toBe(out.m.tiles[0]!.sha256)
})

test("AnnotationDocument round trips and encodes to JSON", () => {
  const doc = makeAnnotationDocument(
    [
      { id: "a1", kind: "point", points: [[1, 2, 3]] },
      { id: "a2", kind: "label", points: [[0, 0, 0]], text: "mid boss", layer: "L1", properties: { note: "x" } },
      { id: "a3", kind: "polyline", points: [[0, 0, 0], [1, 1, 1]] },
      { id: "a4", kind: "polygon", points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], color: "#ff0000" },
      { id: "a5", kind: "measure", points: [[0, 0, 0], [3, 4, 0]] }
    ],
    { mapName: "dl_midtown", layers: [{ id: "L1", name: "Notes", visible: true }] }
  )
  const json = JSON.parse(JSON.stringify(doc))
  const back = Schema.decodeUnknownSync(AnnotationDocument)(json)
  expect(back).toEqual(doc)
  expect(validateAnnotationDocument(back)).toEqual([])
})

test("AnnotationDocument rejects bad geometry and reports cross-field errors", () => {
  const decode = Schema.decodeUnknownSync(AnnotationDocument)
  const base = { schemaVersion: "1.0.0" }
  expect(() => decode({ ...base, annotations: [{ id: "a", kind: "polyline", points: [[0, 0, 0]] }] })).toThrow()
  expect(() => decode({ ...base, annotations: [{ id: "a", kind: "polygon", points: [[0, 0, 0], [1, 1, 1]] }] })).toThrow()
  expect(() => decode({ ...base, annotations: [{ id: "a", kind: "point", points: [[0, 0, 0], [1, 1, 1]] }] })).toThrow()
  expect(() => decode({ ...base, annotations: [{ id: "a", kind: "label", points: [[0, 0, 0]] }] })).toThrow()
  expect(() => decode({ ...base, annotations: [{ id: "a", kind: "circle", points: [[0, 0, 0]] }] })).toThrow()
  expect(() => decode({ ...base, annotations: [{ id: "a", kind: "point", points: [[0, 0, NaN]] }] })).toThrow()
  const dup = decode({
    ...base,
    annotations: [{ id: "a", kind: "point", points: [[0, 0, 0]], layer: "nope" }, { id: "a", kind: "point", points: [[1, 1, 1]] }]
  })
  expect(validateAnnotationDocument(dup)).toEqual(['annotation "a" references unknown layer "nope"', 'duplicate annotation id "a"'])
})

test("decodeVersioned rejects a newer AnnotationDocument major", async () => {
  const exit = await Effect.runPromiseExit(decodeVersioned(AnnotationDocument, 1)({ schemaVersion: "2.0.0", annotations: [] }))
  expect(exit._tag).toBe("Failure")
})

test("mock viewer with tools records registrations and unregisters", async () => {
  const mock = makeMockViewerServiceWithTools()
  const unregister = await Effect.runPromise(
    Effect.gen(function* () {
      const viewer = yield* ViewerService
      const un = yield* viewer.registerTool({ id: "metadata.camp", label: "Camp" })
      expect(mock.registeredTools().map((t) => t.id)).toEqual(["metadata.camp"])
      return un
    }).pipe(Effect.provide(mock.layer))
  )
  unregister()
  expect(mock.registeredTools()).toEqual([])
  // The plain mock has the same members, with a no-op registerTool.
  const plain = await Effect.runPromise(Effect.gen(function* () { return yield* ViewerService }).pipe(Effect.provide(MockViewerService)))
  expect(typeof (await Effect.runPromise(plain.registerTool({ id: "x", label: "X" })))).toBe("function")
  expect(Object.keys(plain).sort()).toEqual(Object.keys(await Effect.runPromise(Effect.gen(function* () { return yield* ViewerService }).pipe(Effect.provide(mock.layer)))).sort())
})

test("mock viewer tracks the active tool; unknown ids are defects; the plain mock has the members as no-ops", async () => {
  const mock = makeMockViewerServiceWithTools()
  await Effect.runPromise(Effect.gen(function* () {
    const v = yield* ViewerService
    expect(mock.activeTool()).toBe("select")
    yield* v.registerTool({ id: "metadata.camp", label: "Camp" })
    yield* v.activateTool!("metadata.camp")
    expect(mock.activeTool()).toBe("metadata.camp")
    yield* v.activateTool!("polygon")
    expect(mock.activeTool()).toBe("polygon")
    yield* v.deactivateTool!()
    expect(mock.activeTool()).toBe("select")
    const bad = yield* Effect.exit(v.activateTool!("nope"))
    expect(bad._tag).toBe("Failure")
  }).pipe(Effect.provide(mock.layer)))
  const plain = await Effect.runPromise(Effect.gen(function* () { return yield* ViewerService }).pipe(Effect.provide(MockViewerService)))
  await Effect.runPromise(plain.activateTool!("x"))
  await Effect.runPromise(plain.deactivateTool!())
})

test("OverlayFeature accepts free-form properties on every variant", () => {
  const props = { entity: "g1", "0.0,": "odd key", nested: { a: [1, 2] } }
  const features: ReadonlyArray<OverlayFeature> = [
    { type: "point", at: [0, 0, 0], properties: props },
    { type: "polyline", points: [[0, 0, 0], [1, 1, 1]], properties: props },
    { type: "polygon", ring: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], label: "x", properties: props }
  ]
  expect(features.every((f) => f.properties === props)).toBe(true)
})
