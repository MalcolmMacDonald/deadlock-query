import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { OverlayFeature, OverlayStyle } from "@deadlock-query/contracts"
import { createTagController, memoryDraftStorage, openDraftStore, tagOf, tagRecordId, TAGS, type TaggableEntity, type ViewerServiceShape } from "../src/editor/index.ts"
import { checkDocument, validateRecords } from "../src/index.ts"

const ents: TaggableEntity[] = [0, 1, 2].map((i) => ({ id: `e:${i}`, position: [i * 100, 0, 0] }))

const setup = async () => {
  const overlays = new Map<string, { features: ReadonlyArray<OverlayFeature>; style?: OverlayStyle }>()
  const viewer = {
    setOverlay: (id: string, features: ReadonlyArray<OverlayFeature>, style?: OverlayStyle) => Effect.sync(() => void overlays.set(id, { features, ...(style ? { style } : {}) })),
    removeOverlay: (id: string) => Effect.sync(() => void overlays.delete(id))
  } as unknown as ViewerServiceShape
  const drafts = await openDraftStore(memoryDraftStorage())
  let picked: TaggableEntity[] = []
  const subs = new Set<() => void>()
  const select = (...e: TaggableEntity[]) => { picked = e; for (const f of subs) f() }
  const tags = createTagController({ viewer, drafts, source: { selected: () => picked, subscribe: (f) => { subs.add(f); return () => void subs.delete(f) } } })
  return { overlays, drafts, tags, select }
}

test("one press tags every selected entity, and tagged state is drawn per tag", async () => {
  const { overlays, drafts, tags, select } = await setup()
  select(ents[0]!, ents[1]!)
  tags.apply("heavy-box")
  expect(drafts.list().map((r) => r.id)).toEqual([tagRecordId("heavy-box", "e:0"), tagRecordId("heavy-box", "e:1")])
  expect(overlays.get("metadata.tags.heavy-box")!.features).toHaveLength(2)
  expect(overlays.get("metadata.tags.heavy-box")!.style?.color).toBe(TAGS.find((t) => t.id === "heavy-box")!.color)
  expect(tags.state().rows.find((r) => r.tag.id === "heavy-box")).toMatchObject({ total: 2, onSelected: 2 })
})

test("tagging twice is the same record; toggle removes when all carry the tag", async () => {
  const { drafts, tags, select } = await setup()
  select(ents[0]!)
  tags.apply("labelling-box"); tags.apply("labelling-box")
  expect(drafts.list()).toHaveLength(1)
  select(ents[0]!, ents[1]!)
  tags.toggle("labelling-box")           // only one carried it: add to the rest
  expect(drafts.list()).toHaveLength(2)
  tags.toggle("labelling-box")           // all carry it: remove
  expect(drafts.list()).toHaveLength(0)
})

test("one entity can carry several tags; clearTag removes a tag everywhere; unknown tags are ignored", async () => {
  const { overlays, drafts, tags, select } = await setup()
  select(ents[0]!, ents[2]!)
  tags.apply("heavy-box"); tags.apply("sinners-entity"); tags.apply("nope")
  expect(drafts.list()).toHaveLength(4)
  expect(tags.state().rows.map((r) => r.total)).toEqual([0, 2, 2])
  tags.clearTag("heavy-box")
  expect(drafts.list().map((r) => tagOf(r)!.tag.id)).toEqual(["sinners-entity", "sinners-entity"])
  expect(overlays.has("metadata.tags.heavy-box")).toBe(false)
})

test("tag records are valid drafts and a submission of them passes the module's checks", async () => {
  const { drafts, tags, select } = await setup()
  select(...ents)
  tags.apply("labelling-box")
  expect(validateRecords(drafts.list(), {}).ok).toBe(true)
  const text = JSON.stringify({ schemaVersion: "1", id: "s1", gameBuildId: "b", mapName: "m", createdAt: "2026-10-07T00:00:00Z", submitter: { name: "Ada" }, records: drafts.list() })
  expect(checkDocument(text, {}, { as: "submission" }).issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([])
})

test("selection changes update the counts without touching drafts", async () => {
  const { tags, select } = await setup()
  const seen: number[] = []
  tags.subscribe((s) => seen.push(s.selected.length))
  select(ents[0]!); select(ents[0]!, ents[1]!)
  expect(seen).toEqual([1, 2])
})
