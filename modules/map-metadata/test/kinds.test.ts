import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { MetadataRecord } from "@deadlock-query/contracts"
import { KINDS, KIND_IDS, firstSelfIntersection, isMetadataKind, kindDefinition, ringsOverlap } from "../src/index.ts"

test("the registry has exactly the kinds contracts defines", () => {
  const fromContracts = MetadataRecord.members.map((m) => m.fields.kind.literal).sort()
  expect([...KIND_IDS].sort()).toEqual(fromContracts)
  for (const id of KIND_IDS) expect(KINDS[id].id).toBe(id)
})

test("each kind's schema accepts its own fixture records and rejects another kind's", () => {
  const camp = { kind: "creepCamp", id: "c", status: "proposed", provenance: {}, position: [0, 0, 0] }
  const decode = (id: Parameters<typeof kindDefinition>[0], v: unknown) => Effect.runSync(Effect.result(Schema.decodeUnknownEffect(kindDefinition(id).schema)(v)))._tag
  expect(decode("creepCamp", camp)).toBe("Success")
  expect(decode("healingOrb", camp)).toBe("Failure")
})

test("tools and styles are unique per kind", () => {
  const defs = KIND_IDS.map(kindDefinition)
  expect(new Set(defs.map((d) => d.tool.id)).size).toBe(defs.length)
  expect(defs.every((d) => /^#[0-9a-f]{6}$/.test(d.style.color))).toBe(true)
})

test("isMetadataKind guards names", () => {
  expect(isMetadataKind("creepCamp")).toBe(true)
  expect(isMetadataKind("toString")).toBe(false)
})

const sq = (x: number, y: number, s: number) => [[x, y, 0], [x + s, y, 0], [x + s, y + s, 0], [x, y + s, 0]] as const
test("polygon helpers", () => {
  expect(firstSelfIntersection(sq(0, 0, 10))).toBeUndefined()
  expect(firstSelfIntersection([[0, 0, 0], [10, 10, 0], [10, 0, 0], [0, 10, 0]])).toEqual([0, 2])
  // A vertex touching a non-adjacent edge is not simple either.
  expect(firstSelfIntersection([[0, 0, 0], [10, 0, 0], [10, 10, 0], [5, 0, 0], [0, 10, 0]])).toBeDefined()
  expect(ringsOverlap(sq(0, 0, 10), sq(5, 5, 10))).toBe(true)
  expect(ringsOverlap(sq(0, 0, 10), sq(2, 2, 2))).toBe(true)
  expect(ringsOverlap(sq(0, 0, 10), sq(0, 0, 10))).toBe(true)
  expect(ringsOverlap(sq(0, 0, 10), sq(20, 0, 10))).toBe(false)
})
