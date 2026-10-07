import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { Submission, makeMockViewerServiceWithTools, ViewerService, type MetadataFile, type OverlayFeature } from "@deadlock-query/contracts"
import { createReviewController, type QueueItem, type ReviewApi } from "../src/editor/index.ts"

const sub = Effect.runSync(Schema.decodeUnknownEffect(Submission)(JSON.parse(readFileSync(new URL("../fixtures/submissions/valid.json", import.meta.url), "utf8"))))
const item: QueueItem = { number: 5, title: "t", branch: `metadata-submission/${sub.id}`, submissionId: sub.id, url: "u", author: "bot", updatedAt: "" }

const setup = (over: Partial<ReviewApi> = {}) => {
  const log: string[] = []
  let queue: QueueItem[] = [item]
  const api: ReviewApi = {
    queue: async () => queue, submission: async () => sub, dataFile: async () => undefined,
    commitFile: async (_i, p) => { log.push(`commit:${p}`) }, merge: async () => { log.push("merge"); queue = [] },
    close: async (_i, c) => { log.push(`close:${c}`); queue = [] }, comment: async (_i, c) => { log.push(`comment:${c}`) }, ...over
  }
  const overlays = new Map<string, ReadonlyArray<OverlayFeature>>()
  const base = Effect.runSync(Effect.service(ViewerService).pipe(Effect.provide(makeMockViewerServiceWithTools().layer)))
  const viewer: typeof base = { ...base, setOverlay: (id, f) => Effect.sync(() => void overlays.set(id, f as ReadonlyArray<OverlayFeature>)), removeOverlay: (id) => Effect.sync(() => void overlays.delete(id)) }
  let name = "Malcolm"
  const c = createReviewController({ api, viewer, reviewer: () => name })
  return { c, log, overlays, setName: (n: string) => { name = n } }
}

test("refresh lists the queue; open loads the submission, draws it and starts with no decisions", async () => {
  const { c, overlays } = setup()
  await c.refresh()
  expect(c.state().queue).toHaveLength(1)
  await c.open(item)
  expect(c.state().open?.submission.id).toBe(sub.id)
  expect(c.state().decisions.size).toBe(0)
  expect([...overlays.keys()].some((k) => k.startsWith("metadata.review."))).toBe(true)
  c.close()
  expect([...overlays.keys()].some((k) => k.startsWith("metadata.review."))).toBe(false)
})

test("commit needs every record decided and a reviewer name, then merges and refreshes the queue", async () => {
  const { c, log, setName } = setup()
  await c.refresh(); await c.open(item)
  await c.commit()
  expect(c.state().error).toContain("Nothing decided")
  c.bulk("acceptValid")
  setName("")
  await c.commit()
  expect(c.state().error).toContain("reviewer")
  setName("Malcolm")
  await c.commit()
  expect(c.state().error).toBeUndefined()
  expect(c.state().notice).toContain("Merged")
  expect(log).toContain("merge")
  expect(c.state().open).toBeUndefined()
  expect(c.state().queue).toEqual([])
})

test("per-record decisions toggle, and partial decisions are refused with the count", async () => {
  const { c } = setup()
  await c.open(item)
  const first = sub.records[0]!.id
  c.decide(first, "accepted")
  expect(c.state().decisions.get(first)?.decision).toBe("accepted")
  c.decide(first, undefined)
  expect(c.state().decisions.size).toBe(0)
  if (sub.records.length > 1) { c.decide(first, "accepted"); await c.commit(); expect(c.state().error).toContain("undecided") }
})

test("request changes and reject need text, post to the PR, and reject closes it", async () => {
  const { c, log } = setup()
  await c.open(item)
  await c.requestChanges("  ")
  expect(c.state().error).toContain("what should change")
  await c.requestChanges("move it")
  expect(log.at(-1)).toContain("Changes requested by Malcolm")
  expect(c.state().open).toBeDefined()
  await c.reject("duplicate")
  expect(log.at(-1)).toBe("close:Rejected by Malcolm: duplicate")
  expect(c.state().open).toBeUndefined()
})

test("API failures become a message, not an exception, and the controller stays usable", async () => {
  const { c } = setup({ queue: async () => { throw new Error("proxy answered 503") } })
  await c.refresh()
  expect(c.state().error).toContain("503")
  expect(c.state().busy).toBe(false)
})
