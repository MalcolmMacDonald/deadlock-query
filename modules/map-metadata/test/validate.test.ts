import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { MetadataRecord } from "@deadlock-query/contracts"
import { checkDocument, validateRecords, validateSubmissionRecords, type CollisionProbe, type ValidationContext } from "../src/index.ts"

const fx = (p: string) => readFileSync(join(import.meta.dir, "../fixtures", p), "utf8")
/** Bounds and identity of `contracts/fixtures/mini-map`, the arena the fixtures are drawn on. */
const mini: ValidationContext = {
  bounds: { min: [-4000, -3000, -50], max: [4000, 3000, 620] },
  expect: { gameBuildId: "0", mapName: "mini_map" }
}
const codes = (r: { issues: ReadonlyArray<{ code: string }> }) => r.issues.map((i) => i.code)

describe("valid fixtures", () => {
  for (const f of ["creepCamp", "walkableRegion", "sinnersSacrifice", "healingOrb", "navLink", "custom", "metadata.bundle"]) {
    test(`${f}.json is accepted`, () => {
      const r = checkDocument(fx(`valid/0/${f}.json`), mini, { fileName: `${f}.json` })
      expect(r.issues).toEqual([])
      expect(r.ok).toBe(true)
    })
  }
  test("submission.json is accepted", () => {
    expect(checkDocument(fx("submissions/valid.json"), mini).issues).toEqual([])
  })
  test("reports degraded mode without a collision probe", () => {
    expect(checkDocument(fx("valid/0/creepCamp.json"), mini).degraded).toBe(true)
  })
})

describe("crafted bad files", () => {
  const cases: ReadonlyArray<readonly [file: string, code: string, ctx?: ValidationContext | undefined, fileName?: string]> = [
    ["not-json.json", "json"],
    ["camp-missing-position.json", "schema"],
    ["future-version.json", "schema-version"],
    ["bowtie-region.json", "polygon-self-intersects"],
    ["repeated-vertex.json", "polygon-repeated-vertex"],
    ["sliver-region.json", "polygon-no-area"],
    ["duplicate-camps.json", "duplicate-nearby"],
    ["duplicate-ids.json", "duplicate-id"],
    ["out-of-bounds.json", "out-of-bounds", mini],
    ["wrong-build.json", "build-mismatch", mini],
    ["wrong-map.json", "map-mismatch", mini],
    ["healingOrb.json", "wrong-file-kind", undefined, "healingOrb.json"],
    ["zero-length-link.json", "link-degenerate"],
    ["submission-accepted.json", "not-proposed"],
    ["submission-empty.json", "schema"],
    ["submission-big.json", "too-large"],
    ["bundle-tampered.json", "hash-mismatch"]
  ]
  for (const [file, code, ctx, fileName] of cases) {
    test(`${file} fails with ${code}`, () => {
      const r = checkDocument(fx(`bad/${file}`), ctx ?? {}, fileName ? { fileName } : {})
      expect(r.ok).toBe(false)
      expect(codes(r)).toContain(code)
    })
  }
})

const acc = { status: "accepted", provenance: {} } as const
const camp = (id: string, position: [number, number, number], status: "accepted" | "proposed" | "rejected" = "accepted"): MetadataRecord =>
  ({ ...acc, status, id, kind: "creepCamp", position }) as MetadataRecord
const region = (id: string, x: number, floorZ = 0, flag: "walkable" | "noGo" = "walkable"): MetadataRecord => ({
  ...acc, id, kind: "walkableRegion", floorZ, flag,
  ring: [[x, 0, floorZ], [x + 100, 0, floorZ], [x + 100, 100, floorZ], [x, 100, floorZ]]
}) as MetadataRecord

describe("cross-record rules", () => {
  test("a point near an existing accepted camp is a duplicate; one far away is fine", () => {
    const existing = [camp("old", [0, 0, 0])]
    expect(codes(validateRecords([camp("near", [100, 0, 0], "proposed")], { existing }))).toContain("duplicate-nearby")
    expect(validateRecords([camp("far", [1000, 0, 0], "proposed")], { existing }).issues).toEqual([])
  })
  test("editing a feature does not collide with its own accepted version", () => {
    const existing = [camp("c", [0, 0, 0])]
    expect(validateRecords([camp("c", [50, 0, 0], "proposed")], { existing }).issues).toEqual([])
  })
  test("rejected or stale neighbours do not count", () => {
    const existing = [camp("old", [0, 0, 0], "rejected")]
    expect(validateRecords([camp("new", [10, 0, 0], "proposed")], { existing }).issues).toEqual([])
  })
  test("each duplicate pair in a batch is reported once", () => {
    const r = validateRecords([camp("a", [0, 0, 0]), camp("b", [10, 0, 0])])
    expect(codes(r).filter((c) => c === "duplicate-nearby")).toHaveLength(1)
  })
  test("overlapping walkable regions at the same height are a warning, not an error", () => {
    const r = validateRecords([region("a", 0), region("b", 50)])
    expect(r.ok).toBe(true)
    expect(r.issues.map((i) => [i.severity, i.code])).toEqual([["warning", "regions-overlap"]])
  })
  test("stacked floors, different flags and disjoint regions are not flagged", () => {
    expect(validateRecords([region("a", 0), region("b", 50, 400)]).issues).toEqual([])
    expect(validateRecords([region("a", 0), region("b", 50, 0, "noGo")]).issues).toEqual([])
    expect(validateRecords([region("a", 0), region("b", 500)]).issues).toEqual([])
  })
  test("a region inside another is flagged", () => {
    const big = { ...region("big", 0), ring: [[0, 0, 0], [1000, 0, 0], [1000, 1000, 0], [0, 1000, 0]] } as MetadataRecord
    expect(codes(validateRecords([big, region("small", 100)]))).toContain("regions-overlap")
  })
  test("a polygon larger than the map is rejected", () => {
    const huge = { ...region("huge", 0), ring: [[-1e5, -1e5, 0], [1e5, -1e5, 0], [1e5, 1e5, 0], [-1e5, 1e5, 0]] } as MetadataRecord
    expect(codes(validateRecords([huge], mini))).toContain("polygon-too-large")
  })
  test("submission status and identity checks", () => {
    const r = validateSubmissionRecords({ gameBuildId: "1", mapName: "mini_map", records: [camp("a", [0, 0, 0])] }, mini)
    expect(codes(r)).toEqual(expect.arrayContaining(["build-mismatch", "not-proposed"]))
  })
})

describe("collision checks", () => {
  /** Flat floor at z = 0 with a solid block at x in [100, 200]. */
  const probe: CollisionProbe = {
    groundZ: (x, _y, zFrom) => (zFrom >= 0 ? (x >= 100 && x <= 200 ? 100 : 0) : undefined),
    insideSolid: (p) => p[0] >= 100 && p[0] <= 200 && p[2] > 0 && p[2] < 100
  }
  const ctx: ValidationContext = { collision: probe }
  test("a point on the floor passes and the report is not degraded", () => {
    const r = validateRecords([camp("ok", [0, 0, 5])], ctx)
    expect(r.issues).toEqual([])
    expect(r.degraded).toBe(false)
  })
  test("a floating point is off the surface", () => {
    expect(codes(validateRecords([camp("up", [0, 0, 300])], ctx))).toContain("not-on-surface")
  })
  test("a point inside solid is rejected", () => {
    expect(codes(validateRecords([camp("in", [150, 0, 50])], ctx))).toContain("inside-solid")
  })
  test("a point with nothing below it has no surface", () => {
    expect(codes(validateRecords([camp("void", [0, 0, -500])], ctx))).toContain("no-surface")
  })
  test("nav link ends are checked", () => {
    const link = { ...acc, id: "l", kind: "navLink", from: [0, 0, 0], to: [0, 500, 400], linkKind: "zipline", bidirectional: true } as MetadataRecord
    const r = validateRecords([link], ctx)
    expect(r.issues.map((i) => i.code)).toEqual(["not-on-surface"])
    expect(r.issues[0]!.message).toContain("to end")
  })
  test("without a probe the same records pass in degraded mode", () => {
    const r = validateRecords([camp("up", [0, 0, 300])])
    expect(r.ok).toBe(true)
    expect(r.degraded).toBe(true)
  })
})
