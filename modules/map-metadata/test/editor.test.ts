import { expect, test } from "bun:test"
import { Effect } from "effect"
import { makeMockViewerServiceWithTools, ViewerService, type ExternalTool, type OverlayFeature, type ToolContext, type Vec3 } from "@deadlock-query/contracts"
import { applyPatch, createEditorController, fieldsFor, memoryDraftStorage, openDraftStore } from "../src/editor/index.ts"
import { KIND_IDS } from "../src/index.ts"

// A viewer that records overlays, flights and tools: the mock service from contracts plus what the controller calls.
const makeViewer = () => {
  const m = makeMockViewerServiceWithTools()
  const overlays = new Map<string, ReadonlyArray<OverlayFeature>>()
  const flights: Vec3[] = []
  const base = Effect.runSync(Effect.service(ViewerService).pipe(Effect.provide(m.layer)))
  const viewer: typeof base = {
    ...base,
    setOverlay: (id, f) => Effect.sync(() => void overlays.set(id, f as ReadonlyArray<OverlayFeature>)),
    removeOverlay: (id) => Effect.sync(() => void overlays.delete(id)),
    flyTo: (t) => Effect.sync(() => void flights.push(t))
  }
  return { viewer, overlays, flights, tool: (id: string) => m.registeredTools().find((t) => t.id === id)! }
}

const ctxFor = () => {
  const log = { draft: [] as ReadonlyArray<OverlayFeature>, status: undefined as string | undefined, done: 0 }
  const ctx: ToolContext = {
    commit: () => { throw new Error("unused") },
    setDraft: (f) => { log.draft = f }, setStatus: (t) => { log.status = t }, done: () => { log.done++ }
  }
  return { ctx, log }
}
const draw = (t: ExternalTool, ...pts: Vec3[]) => { for (const p of pts) t.click!(p) }

const setup = async (storage = memoryDraftStorage()) => {
  const drafts = await openDraftStore(storage)
  const v = makeViewer()
  const controller = createEditorController({ viewer: v.viewer, drafts })
  return { drafts, controller, storage, ...v }
}

test("one tool is registered per kind and the tools are removed on dispose", async () => {
  const { controller, tool } = await setup()
  for (const k of KIND_IDS) expect(tool(`metadata.${k}`)).toBeDefined()
  controller.dispose()
  expect(() => tool("metadata.creepCamp")).not.toThrow()
  expect(tool("metadata.creepCamp")).toBeUndefined()
})

test("a camp is one click, saved as a proposed draft and drawn on the camp layer", async () => {
  const { drafts, tool, overlays } = await setup()
  const t = tool("metadata.creepCamp"); const { ctx } = ctxFor()
  t.activate!(ctx)
  draw(t, [10, 20, 30])
  const [r] = drafts.list()
  expect(r).toMatchObject({ kind: "creepCamp", status: "proposed", position: [10, 20, 30] })
  expect(overlays.get("metadata.drafts.creepCamp")).toHaveLength(1)
})

test("a walkable polygon needs three points, previews while drawing, and takes floorZ from the points", async () => {
  const { drafts, tool } = await setup()
  const t = tool("metadata.walkableRegion"); const { ctx, log } = ctxFor()
  t.activate!(ctx)
  draw(t, [0, 0, 100], [500, 0, 110], [500, 500, 90])
  expect(log.draft.some((f) => f.type === "polygon")).toBe(true)
  t.finish!()
  expect(drafts.list()).toHaveLength(1)
  expect(drafts.list()[0]).toMatchObject({ kind: "walkableRegion", floorZ: 100, flag: "walkable" })
  expect(log.draft).toEqual([])
  // Too few points: nothing is saved and the status says why.
  draw(t, [0, 0, 0], [1, 1, 0]); t.finish!()
  expect(drafts.list()).toHaveLength(1)
  expect(log.status).toContain("at least 3")
})

test("Escape removes the last point, then leaves the tool", async () => {
  const { tool } = await setup()
  const t = tool("metadata.navLink"); const { ctx, log } = ctxFor()
  t.activate!(ctx)
  t.click!([0, 0, 0]); t.cancel!()
  expect(log.done).toBe(0)
  t.cancel!()
  expect(log.done).toBe(1)
})

test("a nav link takes two clicks; custom shape follows the panel option", async () => {
  const { drafts, tool, controller } = await setup()
  const link = tool("metadata.navLink"); link.activate!(ctxFor().ctx)
  draw(link, [0, 0, 0], [1000, 0, 200])
  expect(drafts.list()[0]).toMatchObject({ kind: "navLink", from: [0, 0, 0], to: [1000, 0, 200] })
  controller.setOptions({ customShape: "polyline", customLabel: "door" })
  const c = tool("metadata.custom"); c.activate!(ctxFor().ctx)
  draw(c, [0, 0, 0], [5, 5, 0]); c.finish!()
  expect(drafts.list()[1]).toMatchObject({ kind: "custom", label: "door", geometry: { type: "polyline" } })
})

test("drafts survive a reload: a new store on the same storage lists them again", async () => {
  const first = await setup()
  const camp = first.tool("metadata.creepCamp"); camp.activate!(ctxFor().ctx); draw(camp, [1, 2, 3])
  const poly = first.tool("metadata.walkableRegion"); poly.activate!(ctxFor().ctx)
  draw(poly, [0, 0, 0], [100, 0, 0], [100, 100, 0]); poly.finish!()
  await first.drafts.flush()
  first.controller.dispose()
  const second = await setup(first.storage)
  expect(second.drafts.list().map((r) => r.kind)).toEqual(["creepCamp", "walkableRegion"])
  expect(second.overlays.get("metadata.drafts.walkableRegion")).toHaveLength(1)
})

test("unreadable stored drafts are skipped and counted, not fatal", async () => {
  const storage = memoryDraftStorage()
  await storage.save({ id: "x", kind: "bogus" } as never)
  const { drafts, controller } = await setup(storage)
  expect(drafts.list()).toEqual([])
  expect(controller.state().skipped).toBe(1)
})

test("a failing storage does not stop drawing", async () => {
  const bad = { ...memoryDraftStorage(), save: async () => { throw new Error("quota") } }
  const { drafts, tool } = await setup(bad)
  const t = tool("metadata.healingOrb"); t.activate!(ctxFor().ctx); draw(t, [0, 0, 0])
  await drafts.flush()
  expect(drafts.list()).toHaveLength(1)
})

test("validation issues are attached to drafts and a duplicate camp is flagged", async () => {
  const { controller, tool } = await setup()
  const t = tool("metadata.creepCamp"); t.activate!(ctxFor().ctx)
  draw(t, [0, 0, 0], [50, 0, 0])
  const s = controller.state()
  expect(s.report.ok).toBe(false)
  expect(s.report.issues.some((i) => i.code === "duplicate-nearby")).toBe(true)
  expect([...s.issuesById.values()].flat().length).toBeGreaterThan(0)
})

test("edit applies valid changes and refuses invalid ones", async () => {
  const { controller, drafts, tool } = await setup()
  const t = tool("metadata.creepCamp"); t.activate!(ctxFor().ctx); draw(t, [0, 0, 0])
  const id = drafts.list()[0]!.id
  expect(controller.edit(id, { tier: "strong", name: "Mid camp" })).toBeUndefined()
  expect(drafts.get(id)).toMatchObject({ tier: "strong", name: "Mid camp" })
  expect(controller.edit(id, { tier: "huge" })).toBeString()
  expect(drafts.get(id)).toMatchObject({ tier: "strong" })
  expect(controller.edit(id, { tier: undefined })).toBeUndefined()
  expect((drafts.get(id) as { tier?: string }).tier).toBeUndefined()
  expect(controller.edit(id, { kind: "healingOrb" })).toContain("cannot be edited")
})

test("select flies to the draft and clears when the draft is removed", async () => {
  const { controller, drafts, tool, flights, overlays } = await setup()
  const t = tool("metadata.sinnersSacrifice"); t.activate!(ctxFor().ctx); draw(t, [7, 8, 9])
  const id = drafts.list()[0]!.id
  controller.select(id)
  expect(flights.at(-1)).toEqual([7, 8, 9])
  expect(overlays.has("metadata.selected")).toBe(true)
  controller.remove(id)
  expect(controller.state().selectedId).toBeUndefined()
  expect(overlays.has("metadata.selected")).toBe(false)
  expect(overlays.has("metadata.drafts.sinnersSacrifice")).toBe(false)
})

test("every kind has a form and the form keys exist on a built record", async () => {
  expect(fieldsFor("walkableRegion").map((f) => f.key)).toContain("floorZ")
  for (const k of KIND_IDS) expect(fieldsFor(k).length).toBeGreaterThanOrEqual(2)
  const r = applyPatch({ id: "a", kind: "creepCamp", status: "proposed", provenance: {}, position: [0, 0, 0] }, { name: "x" })
  expect("record" in r && r.record.name).toBe("x")
})

test("activate starts the kind's tool in the viewer; false when the viewer cannot", async () => {
  const { controller, viewer } = await setup()
  expect(controller.activate("creepCamp")).toBe(false)
  const started: string[] = []
  const c2 = createEditorController({ viewer: { ...viewer, registerTool: () => Effect.succeed(() => {}), activateTool: (id) => Effect.sync(() => void started.push(id)) }, drafts: await openDraftStore(memoryDraftStorage()) })
  expect(c2.activate("navLink")).toBe(true)
  expect(started).toEqual(["metadata.navLink"])
})

test("accepted records are drawn dimmed and new drafts are checked against them", async () => {
  const { controller, tool, overlays } = await setup()
  controller.setAccepted([{ id: "acc", kind: "creepCamp", status: "accepted", provenance: {}, position: [0, 0, 0] }])
  expect(overlays.get("metadata.accepted.creepCamp")).toHaveLength(1)
  const t = tool("metadata.creepCamp"); t.activate!(ctxFor().ctx); draw(t, [30, 0, 0])
  expect(controller.state().report.issues.some((i) => i.code === "duplicate-nearby")).toBe(true)
  controller.setAccepted([])
  expect(overlays.has("metadata.accepted.creepCamp")).toBe(false)
})
