import { describe, expect, test } from "bun:test"
import { QueryCancelled, Seq, ctx, progress, withRun } from "../src/index.ts"
import { buildNavMap } from "./navFixture.ts"

describe("cancellation, budget and progress", () => {
  test("outside a run nothing is checked", () => {
    expect(new Seq([1, 2, 3]).select((n) => n * 2).toArray()).toEqual([2, 4, 6])
    expect(() => progress(0.5)).not.toThrow()
    expect(ctx.cancelled).toBe(false)
    expect(ctx.signal).toBeUndefined()
  })
  test("shouldCancel stops a long sequence part-way", () => {
    let seen = 0, stop = false
    const run = () => withRun({ shouldCancel: () => stop }, () =>
      new Seq({ *[Symbol.iterator]() { for (let i = 0; i < 1e6; i++) yield i } }).select((n) => { seen++; if (n === 1000) stop = true; return n }).count())
    expect(run).toThrow(QueryCancelled)
    expect(seen).toBeLessThan(1000 + 300) // polled every 256 checks
  })
  test("an aborted signal stops the run at the next check", () => {
    const ac = new AbortController()
    ac.abort()
    expect(() => withRun({ signal: ac.signal }, () => 1)).toThrow(QueryCancelled)
  })
  test("maxMillis stops a runaway query with reason timeout", () => {
    try {
      withRun({ maxMillis: 20 }, () => new Seq({ *[Symbol.iterator]() { for (;;) yield 1 } }).where(() => true).count())
      throw new Error("not reached")
    } catch (e) {
      expect(e).toBeInstanceOf(QueryCancelled)
      expect((e as QueryCancelled).reason).toBe("timeout")
      expect((e as Error).name).toBe("AbortError")
    }
  })
  test("progress reaches the listener, clamped, and the previous run is restored", () => {
    const got: [number, string | undefined][] = []
    const out = withRun({ onProgress: (f, l) => got.push([f, l]) }, () => {
      progress(0.25, "a"); progress(2); progress(-1)
      return withRun({}, () => { progress(0.5); return ctx.signal })
    })
    expect(out).toBeUndefined()
    expect(got).toEqual([[0.25, "a"], [1, undefined], [0, undefined]]) // the nested run has no listener
  })
  test("library loops are cancellation points: sampling and pair queries on a map", () => {
    const map = buildNavMap()
    expect(() => withRun({ shouldCancel: () => true }, () => map.sample.grid(100).count())).toThrow(QueryCancelled)
    expect(() => withRun({ shouldCancel: () => true }, () => map.healingOrbs.select((o) => o.position).pairs().where(([a, b]) => a.travelDistanceTo(b) > 0).count())).toThrow(QueryCancelled)
    // The same queries complete when nothing cancels, and give the same answer as outside a run.
    const plain = map.sample.grid(500).count()
    expect(withRun({ maxMillis: 60_000 }, () => map.sample.grid(500).count())).toBe(plain)
  })
  test("the signal reaches the navmesh distance field", () => {
    const map = buildNavMap()
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    withRun({ signal: ac.signal }, () => { seen = ctx.signal; return map.guardians.first()!.position.travelTimeTo(map.healingOrbs.first()!.position) })
    expect(seen).toBe(ac.signal)
  })
})
