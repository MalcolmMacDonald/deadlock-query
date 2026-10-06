import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  MetadataBundle, MetadataFile, MetadataRecord, ReviewDecision, Submission, acceptedRecords, buildMiniMap, canonicalJson,
  decodeVersioned, makeMetadataBundle, metadataContentHash, ringArea, validateMetadataRecords, validateSubmission,
  verifyMetadataBundle, type MetadataRecord as Rec, type Provenance
} from "../src/index.ts"

const prov: Provenance = { submitter: { name: "Ada", github: "ada" }, submissionId: "s1", submittedAt: "2026-10-06T12:00:00Z" }
const base = { status: "accepted" as const, provenance: prov }

const camp = (id: string, extra: object = {}): Rec => ({ ...base, id, kind: "creepCamp", position: [0, 0, 0], tier: "medium", ...extra }) as Rec
const records: Rec[] = [
  { ...base, id: "w1", kind: "walkableRegion", ring: [[0, 0, 0], [100, 0, 0], [100, 100, 0]], floorZ: 0, flag: "noGo", costMultiplier: 2 },
  camp("camp-b"), camp("camp-a"),
  { ...base, id: "ss1", kind: "sinnersSacrifice", position: [10, 10, 0], name: "Sacrifice" },
  { ...base, id: "orb1", kind: "healingOrb", position: [5, 5, 0], respawnSeconds: 180 },
  { ...base, id: "l1", kind: "navLink", from: [0, 0, 0], to: [0, 0, 300], linkKind: "zipline", bidirectional: false, cost: 1.5 },
  { ...base, id: "c1", kind: "custom", label: "trap", geometry: { type: "point", at: [1, 2, 3] }, properties: { armed: true, power: 3, tag: "x" } }
]

const decode = <A, I>(schema: Schema.Codec<A, I>, v: unknown) => Effect.runSync(Schema.decodeUnknownEffect(schema)(v))
const fails = (schema: Schema.Codec<any, any>, v: unknown) => expect(() => decode(schema, v)).toThrow()

test("every record kind decodes and round-trips", () => {
  for (const r of records) {
    const d = decode(MetadataRecord, r)
    expect(Effect.runSync(Schema.encodeEffect(MetadataRecord)(d))).toEqual(r)
  }
})

test("records reject bad shapes", () => {
  const w = records[0]!
  fails(MetadataRecord, { ...w, ring: [[0, 0, 0], [1, 1, 1]] })
  fails(MetadataRecord, { ...w, flag: "lava" })
  fails(MetadataRecord, { ...w, costMultiplier: 0 })
  fails(MetadataRecord, { ...camp("x"), tier: "huge" })
  fails(MetadataRecord, { ...camp("x"), id: "" })
  fails(MetadataRecord, { ...camp("x"), position: [0, 0] })
  fails(MetadataRecord, { ...camp("x"), status: "pending" })
  fails(MetadataRecord, { ...camp("x"), kind: "unknown" })
  fails(MetadataRecord, { ...camp("x"), name: "n".repeat(121) })
  fails(MetadataRecord, { ...camp("x"), provenance: { submittedAt: "yesterday" } })
  fails(MetadataRecord, { ...records[6]!, geometry: { type: "polyline", points: [[0, 0, 0]] } })
  fails(MetadataRecord, { ...records[6]!, properties: { nested: { a: 1 } } })
})

test("file, bundle, submission and decision schemas decode", () => {
  const meta = { gameBuildId: "25738777", mapName: "dl_midtown" }
  decode(MetadataFile, { schemaVersion: "1.0.0", ...meta, records })
  const bundle = makeMetadataBundle(meta, records)
  expect(decode(MetadataBundle, bundle).contentHash).toBe(bundle.contentHash)
  const sub = { schemaVersion: "1.0.0", id: "sub-1", ...meta, createdAt: "2026-10-06T12:00:00Z", submitter: { name: "Ada" }, records: [camp("p1", { status: "proposed" })] }
  expect(decode(Submission, sub).records).toHaveLength(1)
  fails(Submission, { ...sub, records: [] })
  fails(Submission, { ...sub, submitter: { name: "" } })
  const d = { submissionId: "sub-1", recordId: "p1", decision: "changesRequested", reviewer: "Mal", decidedAt: "2026-10-06T13:00:00Z", comment: "move it" }
  expect(decode(ReviewDecision, d).decision).toBe("changesRequested")
  fails(ReviewDecision, { ...d, decision: "maybe" })
})

test("versioned decode rejects a newer major", async () => {
  const meta = { gameBuildId: "1", mapName: "m" }
  const ok = await Effect.runPromise(decodeVersioned(MetadataBundle, 1)(makeMetadataBundle(meta, records)))
  expect(ok.records).toHaveLength(records.length)
  const r = await Effect.runPromise(decodeVersioned(MetadataBundle, 1)({ ...makeMetadataBundle(meta, records), schemaVersion: "2.0.0" }).pipe(Effect.result))
  expect(r._tag).toBe("Failure")
})

test("bundle is deterministic: input order does not matter, records sorted by kind then id", () => {
  const meta = { gameBuildId: "1", mapName: "m" }
  const a = makeMetadataBundle(meta, records)
  const b = makeMetadataBundle(meta, [...records].reverse())
  expect(a).toEqual(b)
  expect(a.records.map((r) => r.id)).toEqual(["camp-a", "camp-b", "orb1", "l1", "ss1", "c1", "w1"].sort((x, y) => {
    const kx = a.records.find((r) => r.id === x)!.kind, ky = a.records.find((r) => r.id === y)!.kind
    return kx === ky ? (x < y ? -1 : 1) : kx < ky ? -1 : 1
  }))
  expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/)
})

test("content hash changes with the data and detects tampering", () => {
  const meta = { gameBuildId: "1", mapName: "m" }
  const a = makeMetadataBundle(meta, records)
  expect(verifyMetadataBundle(a)).toBe(true)
  expect(makeMetadataBundle({ ...meta, gameBuildId: "2" }, records).contentHash).not.toBe(a.contentHash)
  expect(makeMetadataBundle(meta, records.slice(1)).contentHash).not.toBe(a.contentHash)
  const edited = { ...a, records: a.records.map((r) => (r.id === "camp-a" ? { ...r, status: "rejected" as const } : r)) }
  expect(verifyMetadataBundle(edited)).toBe(false)
  expect(metadataContentHash(a)).toBe(a.contentHash)
})

test("canonicalJson sorts keys at every level and keeps array order", () => {
  expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}')
})

test("acceptedRecords drops proposed, rejected and stale", () => {
  const mixed = [camp("a"), camp("b", { status: "proposed" }), camp("c", { status: "rejected" }), camp("d", { status: "stale" })]
  expect(acceptedRecords({ records: mixed }).map((r) => r.id)).toEqual(["a"])
})

test("ringArea is the ground-plane area", () => {
  expect(ringArea([[0, 0, 0], [10, 0, 5], [10, 10, 9], [0, 10, 0]])).toBe(100)
  expect(ringArea([[0, 0, 0], [1, 1, 1], [2, 2, 2]])).toBe(0)
})

test("validateMetadataRecords: duplicates, degenerate polygons, bounds, zero-length links", () => {
  expect(validateMetadataRecords(records)).toEqual([])
  const flat: Rec = { ...records[0]!, id: "flat", ring: [[0, 0, 0], [1, 1, 0], [2, 2, 0]] } as Rec
  const link: Rec = { ...records[5]!, id: "loop", to: [0, 0, 0] } as Rec
  const errs = validateMetadataRecords([camp("a"), camp("a"), flat, link]).join("\n")
  expect(errs).toContain('duplicate record id "a"')
  expect(errs).toContain("polygon has no area")
  expect(errs).toContain("from and to are the same point")
  const { bounds } = buildMiniMap().manifest
  expect(validateMetadataRecords([camp("in", { position: [0, 0, 0] })], { bounds })).toEqual([])
  expect(validateMetadataRecords([camp("out", { position: [9000, 0, 0] })], { bounds }).join()).toContain("outside the map bounds")
  expect(validateMetadataRecords([camp("edge", { position: [4100, 0, 0] })], { bounds, boundsMargin: 200 })).toEqual([])
})

test("validateSubmission: proposed only, build and map must match", () => {
  const sub = decode(Submission, {
    schemaVersion: "1.0.0", id: "s", gameBuildId: "1", mapName: "m", createdAt: "2026-10-06T12:00:00Z",
    submitter: { name: "Ada" }, records: [camp("p", { status: "proposed" })]
  })
  expect(validateSubmission(sub, { gameBuildId: "1", mapName: "m" })).toEqual([])
  expect(validateSubmission(sub, { gameBuildId: "2" }).join()).toContain("not the loaded build")
  expect(validateSubmission(sub, { mapName: "other" }).join()).toContain("not the loaded map")
  const bad = { ...sub, records: [camp("a")] }
  expect(validateSubmission(bad).join()).toContain("only contain proposed records")
})
