import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli.ts"
import { GameConsole } from "../src/console.ts"
import { makeFakeGame, type FakeConsoleOptions } from "../src/fake.ts"
import { ringPlan, serializePlan, type ShotPlan } from "../src/plan.ts"
import { shoot, shootEvents, type ShootOptions, type ShootProgress } from "../src/shoot.ts"

const plan = (yaws = 4): ShotPlan => ringPlan({ map: "m", gameBuildId: "7", resolution: { width: 64, height: 36 } }, { at: [[100, 200, 50]], yaws })

const setup = (fake: FakeConsoleOptions = {}, extra: Partial<ShootOptions> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "dlq-resume-"))
  const shots = join(root, "game-shots"), out = join(root, "out")
  const game = makeFakeGame({ screenshotDir: shots, ...fake })
  const events: ShootProgress[] = []
  const opts: ShootOptions = { outDir: out, screenshotDir: shots, gameBuildId: "7", settleMs: 0, pickupTimeoutMs: 100, retryDelayMs: 0, placeholder: true, onProgress: (e) => events.push(e), ...extra }
  const run = (p = plan(), o: Partial<ShootOptions> = {}, layer: Layer.Layer<GameConsole> = game.layer) =>
    Effect.runPromise(shoot(p, { ...opts, ...o }).pipe(Effect.provide(layer), Effect.result))
  const retries = () => events.filter((e) => e._tag === "retry")
  return { root, shots, out, game, events, opts, run, retries }
}
const lines = (out: string) => readFileSync(join(out, "index.jsonl"), "utf8").trim().split("\n")

test("retry: a dropped screenshot is taken again and the run succeeds", async () => {
  const t = setup({ dropFiles: 1 })
  const r = await t.run(plan(2))
  expect(r._tag).toBe("Success")
  expect(t.retries()).toHaveLength(1)
  expect(t.retries()[0]).toMatchObject({ shotId: "ring-001-y000", attempt: 1, attempts: 3 })
  expect(r._tag === "Success" && r.success.shots).toHaveLength(2)
})

test("retry: a pose that settles on the second try passes; a persistent one fails after the attempts", async () => {
  const flaky = setup({ poseDrift: [50, 0, 0], driftFor: 1 })
  expect((await flaky.run(plan(1)))._tag).toBe("Success")
  expect(flaky.retries()).toHaveLength(1)

  const stuck = setup({ poseDrift: [50, 0, 0] })
  const r = await stuck.run(plan(1))
  expect(r._tag === "Failure" && r.failure).toMatchObject({ kind: "pose", shotId: "ring-001-y000" })
  expect(stuck.retries()).toHaveLength(2)

  const once = setup({ poseDrift: [50, 0, 0] })
  await once.run(plan(1), { attempts: 1 })
  expect(once.retries()).toHaveLength(0)
})

test("a refused command is not retried", async () => {
  const t = setup({ rejected: ["screenshot"] })
  const r = await t.run(plan(1))
  expect(r._tag === "Failure" && r.failure.kind).toBe("console")
  expect(t.retries()).toHaveLength(0)
})

test("a slow attempt hits the per-shot timeout", async () => {
  const t = setup({ delayMs: 300 })
  const r = await t.run(plan(1), { shotTimeoutMs: 50, attempts: 1 })
  expect(r._tag === "Failure" && r.failure).toMatchObject({ kind: "timeout", shotId: "ring-001-y000" })
})

test("game exits mid-run: the run stops at once with a resume hint, then --resume finishes it", async () => {
  const t = setup({}, { gameRunning: () => t.game.state.up })
  const killGame = (e: ShootProgress) => { t.events.push(e); if (e._tag === "shot" && e.index === 1) t.game.crash() }
  const first = await t.run(plan(4), { onProgress: killGame })
  expect(first._tag === "Failure" && first.failure).toMatchObject({ kind: "game-lost", shotId: "ring-001-y180" })
  expect(first._tag === "Failure" && first.failure.remediation).toContain("--resume")
  expect(t.retries()).toHaveLength(0)
  expect(lines(t.out)).toHaveLength(2)
  expect(existsSync(join(t.out, "index.json"))).toBe(false)

  t.game.restart()
  t.game.log.length = 0
  const second = await t.run(plan(4), { resume: true, onProgress: (e) => t.events.push(e) })
  expect(second._tag).toBe("Success")
  expect(second._tag === "Success" && second.success.shots.map((s) => s.id)).toEqual(["ring-001-y000", "ring-001-y090", "ring-001-y180", "ring-001-y270"])
  expect(t.events.some((e) => e._tag === "resumed" && e.done === 2 && e.total === 4)).toBe(true)
  // only the two missing shots were driven
  expect(t.game.log.filter((c) => c.startsWith("setpos"))).toEqual(["setpos 100 200 50", "setpos 100 200 50"])
  expect(lines(t.out)).toHaveLength(4)
  expect(existsSync(join(t.out, "index.json"))).toBe(true)
})

test("console blips while the game is still running are retried, then reported as game-lost with a resume hint", async () => {
  const t = setup({}, { gameRunning: () => true })
  t.game.crash()
  const r = await t.run(plan(1), { setup: [] })
  expect(r._tag === "Failure" && r.failure.kind).toBe("game-lost")
  expect(t.retries()).toHaveLength(2)
  expect(r._tag === "Failure" && r.failure.remediation).toContain("--resume")
})

test("resume: nothing to do for a finished run; works on a fresh folder; refuses --force together", async () => {
  const t = setup()
  expect((await t.run(plan(2)))._tag).toBe("Success")
  t.game.log.length = 0
  const again = await t.run(plan(2), { resume: true })
  expect(again._tag).toBe("Success")
  expect(t.game.log).toEqual([]) // not even session setup
  expect(existsSync(join(t.out, "index.json"))).toBe(true)

  const fresh = setup()
  expect((await fresh.run(plan(1), { resume: true }))._tag).toBe("Success")

  const both = await t.run(plan(2), { resume: true, force: true })
  expect(both._tag === "Failure" && both.failure.kind).toBe("output")
})

test("resume: half-written last line and missing files are retaken, a changed plan is an error", async () => {
  const t = setup()
  expect((await t.run(plan(3)))._tag).toBe("Success")
  appendFileSync(join(t.out, "index.jsonl"), '{"id":"ring-001-y0')
  rmSync(join(t.out, "ring-001-y120.png"))
  t.events.length = 0
  const r = await t.run(plan(3), { resume: true })
  expect(r._tag).toBe("Success")
  expect(r._tag === "Success" && r.success.shots).toHaveLength(3)
  const warnings = t.events.flatMap((e) => (e._tag === "warning" ? [e.message] : []))
  expect(warnings).toHaveLength(2)
  expect(warnings.some((w) => w.includes("ring-001-y120.png is missing"))).toBe(true)
  expect(warnings.some((w) => w.includes("half-written"))).toBe(true)
  expect(existsSync(join(t.out, "ring-001-y120.png"))).toBe(true)
  expect(lines(t.out)).toHaveLength(3)

  const changed = await t.run(ringPlan({ map: "m", gameBuildId: "7", resolution: { width: 64, height: 36 } }, { at: [[999, 0, 0]], yaws: 3 }), { resume: true })
  expect(changed._tag === "Failure" && changed.failure).toMatchObject({ kind: "plan" })
  expect(changed._tag === "Failure" && changed.failure.remediation).toContain("--force")

  writeFileSync(join(t.out, "index.jsonl"), 'garbage\n{"id":"x"}\n')
  const damaged = await t.run(plan(3), { resume: true })
  expect(damaged._tag === "Failure" && damaged.failure.kind).toBe("output")
})

test("progress stream: events in order, ends after done; fails with the ShootError", async () => {
  const t = setup()
  const evs = await Effect.runPromise(Stream.runCollect(shootEvents(plan(2), t.opts)).pipe(Effect.provide(t.game.layer)))
  expect(evs.map((e) => e._tag)).toEqual(["start", "shot", "shot", "done"])

  const bad = setup({ rejected: ["screenshot"] })
  const r = await Effect.runPromise(Stream.runCollect(shootEvents(plan(2), bad.opts)).pipe(Effect.provide(bad.game.layer), Effect.result))
  expect(r._tag === "Failure" && r.failure.kind).toBe("console")
})

const capture = async (f: () => Promise<number>) => {
  const err: string[] = [], out: string[] = []
  const e = console.error, l = console.log
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  try { return { code: await f(), err: err.join("\n"), out: out.join("\n") } } finally { console.error = e; console.log = l }
}

test("cli: --resume continues a finished run, --json prints one event per line, --resume with --force is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "dlq-cli-resume-"))
  const planFile = join(root, "plan.json"), out = join(root, "out")
  writeFileSync(planFile, serializePlan(plan(2)))
  expect((await capture(() => main(["shoot", planFile, "--fake", "--out", out], {}))).code).toBe(0)
  const r = await capture(() => main(["shoot", planFile, "--fake", "--out", out, "--resume"], {}))
  expect(r.code).toBe(0)
  expect(r.err).toContain("resuming: 2 of 2 shots already taken")
  const j = await capture(() => main(["shoot", planFile, "--fake", "--out", out, "--force", "--json"], {}))
  expect(j.code).toBe(0)
  const evs = j.out.split("\n").map((l) => JSON.parse(l))
  expect(evs.map((e) => e._tag)).toEqual(["start", "shot", "shot", "done"])
  const both = await capture(() => main(["shoot", planFile, "--fake", "--out", out, "--resume", "--force"], {}))
  expect(both.code).toBe(2)
  expect(both.err).toContain("cannot be combined")
  expect((await capture(() => main(["shoot", planFile, "--fake", "--out", out, "--attempts", "x"], {}))).code).toBe(2)
})
