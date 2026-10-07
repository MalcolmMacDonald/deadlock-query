import { expect, test } from "bun:test"
import type { Vec3 } from "@deadlock-query/contracts"
import { ViewerController, TOOL_IDS, type ExternalTool, type ToolContext } from "../src/index.ts"

/** Sample external tool: drops a tagged point, previews a marker under the cursor, and counts what it was fed. */
const sampleTool = (log: string[] = []) => {
  let ctx: ToolContext | undefined
  const tool: ExternalTool = {
    id: "sample.pin", label: "Pin", hint: "Click to pin.",
    activate: (c) => { ctx = c; log.push("activate") },
    deactivate: () => { ctx = undefined; log.push("deactivate") },
    click: (p: Vec3) => { ctx!.commit({ kind: "point", points: [p], properties: { tool: "sample.pin" } }); ctx!.setStatus("pinned"); log.push("click") },
    move: (p: Vec3) => ctx!.setDraft([{ type: "point", at: p }]),
    finish: () => { log.push("finish"); ctx!.done() },
    cancel: () => log.push("cancel")
  }
  return tool
}

test("an external tool registered by another module is selectable and receives clicks, moves, finish and cancel", () => {
  const c = new ViewerController()
  const log: string[] = []
  const unregister = c.registerTool(sampleTool(log))
  expect(c.tools.registered.map((t) => t.id)).toEqual(["sample.pin"])
  c.tools.setTool("sample.pin")
  expect(c.tools.tool).toBe("sample.pin")
  c.tools.move([1, 2, 3])
  expect(c.tools.draft()).toEqual([{ type: "point", at: [1, 2, 3] }])
  c.tools.click([1, 2, 3], 0)
  expect(c.annotations.annotations).toHaveLength(1)
  expect(c.annotations.annotations[0]).toMatchObject({ kind: "point", points: [[1, 2, 3]], properties: { tool: "sample.pin" } })
  expect(c.tools.status).toBe("pinned")
  c.tools.cancel()
  c.tools.finish() // the tool calls done(): back to Select, draft and status cleared
  expect(log).toEqual(["activate", "click", "cancel", "finish", "deactivate"])
  expect(c.tools.tool).toBe("select")
  expect(c.tools.draft()).toEqual([])
  expect(c.tools.status).toBeUndefined()
  c.annotations.undo()
  expect(c.annotations.annotations).toHaveLength(0) // one undo step, like a built-in tool
  unregister()
  expect(c.tools.registered).toHaveLength(0)
})

test("external tools draw into the active layer and switching tools deactivates them", () => {
  const c = new ViewerController()
  const log: string[] = []
  c.registerTool(sampleTool(log))
  const layer = c.annotations.addLayer("Pins")
  c.setActiveLayer(layer.id)
  c.tools.setTool("sample.pin")
  c.tools.click([0, 0, 0], 0)
  expect(c.annotations.annotations[0]!.layer).toBe(layer.id)
  c.tools.setTool("point")
  expect(log).toEqual(["activate", "click", "deactivate"])
  // Back on the built-in point tool: clicks no longer reach the external tool.
  c.tools.click([5, 5, 5], 10_000)
  expect(c.annotations.annotations).toHaveLength(2) // that was the built-in point tool
})

test("unregistering the active tool deactivates it and returns to Select; ids must be unique and not built in", () => {
  const c = new ViewerController()
  const log: string[] = []
  const off = c.registerTool(sampleTool(log))
  expect(() => c.registerTool(sampleTool())).toThrow(/already registered/)
  expect(() => c.registerTool({ ...sampleTool(), id: "point" })).toThrow(/built-in/)
  expect(TOOL_IDS).toContain("point")
  c.tools.setTool("sample.pin")
  off()
  expect(c.tools.tool).toBe("select")
  expect(log).toEqual(["activate", "deactivate"])
  c.tools.setTool("sample.pin") // gone: ignored
  expect(c.tools.tool).toBe("select")
  off() // idempotent
  c.registerTool(sampleTool()) // the id can be registered again
})

test("activateTool selects a built-in or registered tool, deactivateTool returns to Select, unknown ids throw", () => {
  const c = new ViewerController()
  c.registerTool(sampleTool())
  c.activateTool("sample.pin")
  expect(c.tools.tool).toBe("sample.pin")
  c.activateTool("polygon")
  expect(c.tools.tool).toBe("polygon")
  c.deactivateTool()
  expect(c.tools.tool).toBe("select")
  expect(() => c.activateTool("nope")).toThrow()
})
