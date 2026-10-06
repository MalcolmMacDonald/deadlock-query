import { expect, test } from "bun:test"
import { MAX_HISTORY, MAX_SAVED, STORAGE_KEY, makeQueryStore, type KeyValueStorage } from "../src/store/queryStore.ts"
import { dlqFilename, exportDlq, parseDlq } from "../src/store/dlqFile.ts"

const memory = (): KeyValueStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}
let t = 0
const clock = () => ++t
let n = 0
const ids = () => `id${++n}`

test("saved queries persist, replace by name and delete", () => {
  const storage = memory()
  const a = makeQueryStore(storage, clock, ids)
  a.save("Orbs", "map.healingOrbs", "0.1.0")
  a.save("Camps", "map.creepCamps", "0.1.0")
  const replaced = a.save("  Orbs ", "map.healingOrbs.count()", "0.1.0")
  expect(a.saved().map((s) => [s.name, s.source])).toEqual([["Orbs", "map.healingOrbs.count()"], ["Camps", "map.creepCamps"]])
  expect(replaced.id).toBe(a.saved()[0]!.id)

  const reloaded = makeQueryStore(storage, clock, ids)
  expect(reloaded.saved()).toEqual(a.saved())
  reloaded.remove(replaced.id)
  expect(makeQueryStore(storage).saved().map((s) => s.name)).toEqual(["Camps"])
})

test("saving validates the name, size and count", () => {
  const s = makeQueryStore(memory(), clock, ids)
  expect(() => s.save("   ", "x")).toThrow(/name/)
  expect(() => s.save("big", "x".repeat(100_001))).toThrow(/too large/)
  for (let i = 0; i < MAX_SAVED; i++) s.save(`q${i}`, "x")
  expect(() => s.save("one more", "x")).toThrow(/up to 200/)
  s.save("q0", "changed") // replacing is still allowed at the limit
  expect(s.saved()).toHaveLength(MAX_SAVED)
})

test("history is newest first, bounded, and collapses an immediate repeat", () => {
  const s = makeQueryStore(memory(), clock, ids)
  s.record({ source: "a", status: "ok", rows: 1 })
  s.record({ source: "a", status: "ok", rows: 1 })
  s.record({ source: "a", status: "error", error: "boom" })
  s.record({ source: "b", status: "ok", rows: 2 })
  expect(s.history().map((h) => [h.source, h.status])).toEqual([["b", "ok"], ["a", "error"], ["a", "ok"]])
  for (let i = 0; i < MAX_HISTORY + 10; i++) s.record({ source: `q${i}`, status: "ok", rows: i })
  expect(s.history()).toHaveLength(MAX_HISTORY)
  expect(s.history()[0]!.source).toBe(`q${MAX_HISTORY + 9}`)
  s.clearHistory()
  expect(s.history()).toEqual([])
})

test("corrupt or hostile storage is ignored; failing storage keeps the panel working", () => {
  for (const bad of ["not json", "[]", '{"saved":"x","history":7}', '{"saved":[{"id":1}],"history":[{"source":"a","at":"now","status":"ok"}]}']) {
    const storage = memory()
    storage.data.set(STORAGE_KEY, bad)
    const s = makeQueryStore(storage)
    expect(s.saved()).toEqual([])
    expect(s.history()).toEqual([])
  }
  const full: KeyValueStorage = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("quota") } }
  const s = makeQueryStore(full, clock, ids)
  s.save("q", "x")
  s.record({ source: "x", status: "ok", rows: 1 })
  expect(s.saved()).toHaveLength(1)
  expect(makeQueryStore(undefined).saved()).toEqual([])
})

test(".dlq.json round-trips queries and rejects anything else", () => {
  const queries = [{ name: "Orbs", source: "map.healingOrbs", apiVersion: "0.1.0" }, { name: "No version", source: "1+1" }]
  expect(parseDlq(exportDlq(queries)).queries).toEqual(queries)
  expect(() => parseDlq("nope")).toThrow(/not valid JSON/)
  expect(() => parseDlq('{"kind":"other","version":1,"queries":[]}')).toThrow(/not a Deadlock Query file/)
  expect(() => parseDlq('{"kind":"deadlock-query","version":1,"queries":[{"name":"x"}]}')).toThrow(/not a Deadlock Query file/)
  expect(() => parseDlq("x".repeat(2_000_001))).toThrow(/too large/)
  expect(dlqFilename("Orbs within 10 s!")).toBe("orbs-within-10-s.dlq.json")
  expect(dlqFilename("???")).toBe("query.dlq.json")
})
