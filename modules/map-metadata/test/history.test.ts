import { expect, test } from "bun:test"
import type { MetadataRecord } from "@deadlock-query/contracts"
import { historyRow, historyRows, statusCounts } from "../src/index.ts"

const camp = (id: string, over: Partial<MetadataRecord> = {}): MetadataRecord => ({ id, kind: "creepCamp", status: "accepted", provenance: {}, position: [0, 0, 0], ...over }) as MetadataRecord

test("a record's provenance reads as an audit trail, oldest event first", () => {
  const r = historyRow(camp("a", { name: "Mid camp", provenance: { submitter: { name: "Ada", github: "ada" }, submittedAt: "2026-10-06T12:00:00Z", submissionId: "sub-1", reviewer: "Malcolm", reviewedAt: "2026-10-07T01:00:00Z", comment: "good" } }))
  expect(r.label).toBe("Mid camp")
  expect(r.events).toEqual(["Submitted by Ada (@ada, unverified) on 2026-10-06 (sub-1).", "Accepted by Malcolm on 2026-10-07: good"])
})

test("records without provenance still produce a row; stale and rejected get their own verbs", () => {
  expect(historyRow(camp("b")).events).toEqual([])
  expect(historyRow(camp("b")).submitter).toBe("unknown")
  expect(historyRow(camp("c", { status: "stale", provenance: { comment: "outside the map" } })).events).toEqual(["Comment: outside the map"])
  expect(historyRow(camp("d", { status: "rejected", provenance: { reviewer: "M", reviewedAt: "2026-10-07T00:00:00Z" } })).events[0]).toBe("Rejected by M on 2026-10-07.")
})

test("rows are newest first and filter by status, kind and text", () => {
  const rs = [
    camp("old", { provenance: { reviewedAt: "2026-10-01T00:00:00Z", reviewer: "M" } }),
    camp("new", { provenance: { reviewedAt: "2026-10-05T00:00:00Z", reviewer: "M" } }),
    camp("p", { status: "proposed", provenance: { submitter: { name: "Zed" }, submittedAt: "2026-10-06T00:00:00Z" } }),
    { id: "orb1", kind: "healingOrb", status: "accepted", provenance: {}, position: [0, 0, 0] } as MetadataRecord
  ]
  expect(historyRows(rs).map((r) => r.id)).toEqual(["p", "new", "old", "orb1"])
  expect(historyRows(rs, { status: "proposed" }).map((r) => r.id)).toEqual(["p"])
  expect(historyRows(rs, { kind: "healingOrb" }).map((r) => r.id)).toEqual(["orb1"])
  expect(historyRows(rs, { text: "zed" }).map((r) => r.id)).toEqual(["p"])
  expect(statusCounts(rs)).toEqual({ proposed: 1, accepted: 3, rejected: 0, stale: 0 })
})
