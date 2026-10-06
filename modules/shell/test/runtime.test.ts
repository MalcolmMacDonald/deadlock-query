import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { ModuleDefinition } from "@deadlock-query/contracts"
import { SelectionBus } from "@deadlock-query/contracts"
import { composeModules } from "../src/runtime.ts"

const mod = (id: string, layer: Layer.Layer<never, never, any>): ModuleDefinition<any> => ({ id, layer, panels: [] })

describe("composeModules", () => {
  test("isolates a module whose Layer dies; others stay live and share base services", async () => {
    const good = mod("good", Layer.effectDiscard(Effect.gen(function* () {
      const bus = yield* SelectionBus
      yield* bus.select(["a"])
    })))
    const bad = mod("bad", Layer.effectDiscard(Effect.die(new Error("boom"))))
    const c = await composeModules([bad, good])
    expect(c.healthy.map((m) => m.id)).toEqual(["good"])
    expect(c.failed).toHaveLength(1)
    expect(c.failed[0]!.moduleId).toBe("bad")
    expect(c.failed[0]!.message).toContain("boom")
    const ids = await c.runtime.runPromise(Effect.gen(function* () {
      return yield* (yield* SelectionBus).current
    }))
    expect(ids).toEqual(["a"])
    await c.runtime.dispose()
  })

  test("all healthy", async () => {
    const c = await composeModules([mod("x", Layer.empty)])
    expect(c.failed).toEqual([])
    await c.runtime.dispose()
  })
})

describe("appBaseLayer", () => {
  test("ViewerService is backed by the controller the Map panel shares", async () => {
    const { appBaseLayer } = await import("../src/runtime.ts")
    const { getViewerController } = await import("../src/viewer.ts")
    const { ViewerService } = await import("@deadlock-query/contracts")
    const c = await composeModules([mod("x", Layer.empty)], appBaseLayer)
    await c.runtime.runPromise(Effect.gen(function* () {
      const v = yield* ViewerService
      yield* v.setCamera([0, 0, 500], [0, 0, 0])
    }))
    const ctrl = await getViewerController()
    expect(ctrl.getPose().target).toEqual([0, 0, 0])
    expect(ctrl.getPose().distance).toBeCloseTo(500, 0)
  })
})
