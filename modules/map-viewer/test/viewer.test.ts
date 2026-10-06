import { expect, test } from "bun:test"
import { Effect } from "effect"
import { MockMapDataService } from "@deadlock-query/contracts"
import { boundsOf, fitTopDown, loadViewerData, makeViewerModule, VIEWER_PANEL_ID } from "../src/index.ts"

test("module exposes the viewer panels backed by the mock MapDataService", async () => {
  const data = await Effect.runPromise(loadViewerData.pipe(Effect.provide(MockMapDataService)))
  expect(data.entities.length).toBeGreaterThan(0)
  const mod = makeViewerModule(data)
  expect(mod.id).toBe("map-viewer")
  expect(mod.panels.map((p) => p.id)).toEqual([VIEWER_PANEL_ID, "viewer.layers", "viewer.tools"])
  expect(typeof (mod.panels[0]!.component as { mount: unknown }).mount).toBe("function")
})

test("top-down fit keeps points inside the canvas and y up", () => {
  const b = boundsOf([[-100, -50, 0], [100, 50, 0]])
  const p = fitTopDown(b, 400, 400)
  const [x0, y0] = p([-100, -50, 0])
  const [x1, y1] = p([100, 50, 0])
  expect(x0).toBeCloseTo(0); expect(x1).toBeCloseTo(400)
  expect(y0).toBeGreaterThan(y1)
  expect(y0).toBeLessThanOrEqual(400)
})
