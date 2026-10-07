import { expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { MockSelectionBus, SelectionBus } from "../src/index.ts"

test("MockSelectionBus.changes emits each new selection", async () => {
  const out = await Effect.runPromise(Effect.gen(function* () {
    const bus = yield* SelectionBus
    const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(bus.changes!, 2)))
    yield* Effect.sleep(20)
    yield* bus.select(["a"])
    yield* bus.select(["b", "c"])
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(MockSelectionBus), Effect.scoped as never))
  expect(JSON.stringify(out)).toContain("b")
})
