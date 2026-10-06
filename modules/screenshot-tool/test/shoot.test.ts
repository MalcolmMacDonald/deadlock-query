import { expect, test } from "bun:test"
import { ScreenshotSet, validateScreenshotSet } from "@deadlock-query/contracts"
import { Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli.ts"
import { GameConsole } from "../src/console.ts"
import { makeFakeGame, type FakeConsoleOptions } from "../src/fake.ts"
import { imageSize, placeholderPng } from "../src/image.ts"
import { parsePlan, ringPlan, serializePlan } from "../src/plan.ts"
import { parseGetpos, sessionSetup, shoot, type ShootOptions, type ShootProgress } from "../src/shoot.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "dlq-shoot-test-"))
const plan = (yaws = 4) => ringPlan({ map: "m", gameBuildId: "7", resolution: { width: 64, height: 36 } }, { at: [[100, 200, 50]], yaws })

const setup = (fake: FakeConsoleOptions = {}, extra: Partial<ShootOptions> = {}) => {
  const root = tmp()
  const shots = join(root, "game-shots"), out = join(root, "out")
  const game = makeFakeGame({ screenshotDir: shots, ...fake })
  const events: ShootProgress[] = []
  const opts: ShootOptions = { outDir: out, screenshotDir: shots, gameBuildId: "7", settleMs: 0, pickupTimeoutMs: 2000, retryDelayMs: 0, placeholder: true, onProgress: (e) => events.push(e), ...extra }
  const run = (p = plan(), layer: Layer.Layer<GameConsole> = game.layer, o = opts) => Effect.runPromise(shoot(p, o).pipe(Effect.provide(layer), Effect.result))
  return { root, shots, out, game, events, opts, run }
}

test("image size: PNG round trip and a hand-made JPEG header", () => {
  expect(imageSize(placeholderPng(37, 11, 5))).toEqual({ width: 37, height: 11, format: "png" })
  // SOI, APP0 (len 4), SOF0 (len 11, 8 bit, h=480, w=640)
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0])
  expect(imageSize(jpg)).toEqual({ width: 640, height: 480, format: "jpeg" })
  expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined()
})

test("getpos parsing: plain, _exact, newline-separated, roll optional, garbage", () => {
  expect(parseGetpos("setpos 1 -2.5 3e2;setang 10 20 30")).toEqual({ position: [1, -2.5, 300], angles: [10, 20, 30] })
  expect(parseGetpos("setpos_exact 1.0 2.0 3.0;setang_exact 0.0 90.0 0.0")).toEqual({ position: [1, 2, 3], angles: [0, 90, 0] })
  expect(parseGetpos("noise\nsetpos 1 2 3\nsetang 4 5")).toEqual({ position: [1, 2, 3], angles: [4, 5, 0] })
  expect(parseGetpos("Unknown command: getpos")).toBeUndefined()
})

test("shoot against the fake game produces a valid ScreenshotSet with real files", async () => {
  const t = setup()
  const r = await t.run()
  expect(r._tag).toBe("Success")
  if (r._tag !== "Success") return
  const set = r.success
  expect(set.shots.map((s) => s.id)).toEqual(["ring-001-y000", "ring-001-y090", "ring-001-y180", "ring-001-y270"])
  expect(set).toMatchObject({ gameBuildId: "7", mapName: "m", fov: 90, hideHud: true, placeholder: true, tool: { name: "dlq-shoot" } })
  for (const s of set.shots) {
    const bytes = readFileSync(join(t.out, s.file))
    expect(s.bytes).toBe(bytes.length)
    expect(s.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect([s.width, s.height]).toEqual([64, 36])
    expect(s.actual).toEqual(s.requested)
  }
  expect(readdirSync(t.shots)).toEqual([]) // screenshots were moved out of the game folder
  const onDisk = Schema.decodeUnknownSync(ScreenshotSet)(JSON.parse(readFileSync(join(t.out, "index.json"), "utf8")))
  expect(validateScreenshotSet(onDisk)).toEqual([])
  expect(readFileSync(join(t.out, "index.jsonl"), "utf8").trim().split("\n")).toHaveLength(4)
  expect(t.game.log.slice(0, 2)).toEqual(["fov_desired 90", "cl_drawhud 0"])
  expect(t.game.log.slice(2, 6)).toEqual(["setpos 100 200 50", "setang 0 0 0", "getpos", "screenshot"])
  expect(t.events.filter((e) => e._tag === "shot")).toHaveLength(4)
  expect(t.events.at(-1)?._tag).toBe("done")
})

test("lookAt shots are sent as the computed angles and keep their lookAt", async () => {
  const t = setup()
  const p = parsePlan({ schemaVersion: "1.0.0", map: "m", resolution: { width: 64, height: 36 }, fov: 80, hideHud: false, shots: [{ id: "a", position: [0, 0, 0], lookAt: [0, 100, 0] }] })
  const r = await t.run(p)
  expect(r._tag === "Success" && r.success.shots[0]).toMatchObject({ lookAt: [0, 100, 0], requested: { angles: [0, 90, 0] } })
  expect(t.game.log).toContain("setang 0 90 0")
  expect(t.game.log).toContain("cl_drawhud 1")
})

test("a screenshot that shows up late is still picked up", async () => {
  const t = setup({ fileDelayMs: 120 })
  const r = await t.run(plan(1))
  expect(r._tag).toBe("Success")
})

test("no screenshot file: pickup times out naming the folder, nothing is indexed", async () => {
  const t = setup({ dropFiles: true }, { pickupTimeoutMs: 150 })
  const r = await t.run(plan(2))
  expect(r._tag === "Failure" && r.failure).toMatchObject({ kind: "pickup", shotId: "ring-001-y000" })
  expect(r._tag === "Failure" && r.failure.detail).toContain(t.shots)
  expect(existsSync(join(t.out, "index.json"))).toBe(false)
})

test("a game that does not honour the pose fails the shot before capturing", async () => {
  const t = setup({ poseDrift: [50, 0, 0] })
  const r = await t.run()
  expect(r._tag === "Failure" && r.failure).toMatchObject({ kind: "pose", shotId: "ring-001-y000" })
  expect(t.game.state.screenshots).toBe(0)
})

test("setup problems: cheat-gated command, unknown command", async () => {
  const gated = setup({ rejected: ["cl_drawhud"] })
  const a = await gated.run()
  expect(a._tag === "Failure" && a.failure.kind).toBe("setup")
  const unknown = setup({}, { setup: ["bogus_cmd 1"] })
  const b = await unknown.run()
  expect(b._tag === "Failure" && b.failure).toMatchObject({ kind: "setup" })
  expect(sessionSetup({ fov: 70, hideHud: false })).toEqual(["fov_desired 70", "cl_drawhud 1"])
  const skip = setup({}, { setup: [] })
  await skip.run(plan(1))
  expect(skip.game.log[0]).toBe("setpos 100 200 50")
})

test("an existing run is refused unless --force", async () => {
  const t = setup()
  expect((await t.run(plan(1)))._tag).toBe("Success")
  const again = await t.run(plan(1))
  expect(again._tag === "Failure" && again.failure.kind).toBe("output")
  const forced = await t.run(plan(1), t.game.layer, { ...t.opts, force: true })
  expect(forced._tag).toBe("Success")
  expect(readFileSync(join(t.out, "index.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
})

test("an unreadable getpos reply warns instead of failing", async () => {
  const t = setup()
  const blind = Layer.effect(GameConsole)(Effect.gen(function* () {
    const real = yield* GameConsole
    return { send: (c: string) => (c === "getpos" ? Effect.succeed("nothing useful") : real.send(c)) }
  }).pipe(Effect.provide(t.game.layer)))
  const r = await t.run(plan(1), blind)
  expect(r._tag === "Success" && r.success.shots[0]!.actual).toBeUndefined()
  expect(t.events.some((e) => e._tag === "warning" && /pose not verified/.test(e.message))).toBe(true)
})

test("image size differing from the plan resolution is a warning", async () => {
  const t = setup({ imageSize: { width: 32, height: 18 } })
  expect((await t.run(plan(1)))._tag).toBe("Success")
  expect(t.events.some((e) => e._tag === "warning" && /32x18/.test(e.message))).toBe(true)
})

const capture = async (f: () => Promise<number>) => {
  const err: string[] = [], out: string[] = []
  const e = console.error, l = console.log
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  try { return { code: await f(), err: err.join("\n"), out: out.join("\n") } } finally { console.error = e; console.log = l }
}

test("cli: shoot --fake end to end; real game needs --offline and a build id", async () => {
  const root = tmp()
  const planFile = join(root, "plan.json"), out = join(root, "out")
  writeFileSync(planFile, serializePlan(plan(2)))
  const ok = await capture(() => main(["shoot", planFile, "--fake", "--out", out], {}))
  expect(ok.code).toBe(0)
  expect(ok.out).toContain("wrote 2 shots (placeholder images)")
  expect(JSON.parse(readFileSync(join(out, "index.json"), "utf8")).placeholder).toBe(true)
  const again = await capture(() => main(["shoot", planFile, "--fake", "--out", out], {}))
  expect(again.code).toBe(2)
  expect(again.err).toContain("--force")
  expect((await capture(() => main(["shoot", planFile, "--fake", "--out", out, "--force"], {}))).code).toBe(0)

  const refused = await capture(() => main(["shoot", planFile, "--screenshot-dir", root], {}))
  expect(refused.code).toBe(1)
  expect(refused.err).toContain("--offline")
  const noBuild = join(root, "nobuild.json")
  writeFileSync(noBuild, serializePlan(ringPlan({ map: "m" }, { at: [[0, 0, 0]] })))
  const nb = await capture(() => main(["shoot", noBuild, "--offline", "--screenshot-dir", root], {}))
  expect(nb.code).toBe(2)
  expect(nb.err).toContain("--build")
  expect((await capture(() => main(["shoot"], {}))).code).toBe(1)
  expect((await capture(() => main(["shoot", join(root, "missing.json"), "--fake"], {}))).code).toBe(2)
})

test("cli: shoot against a dead console port reports the console error and exits 2", async () => {
  const root = tmp()
  const planFile = join(root, "plan.json")
  writeFileSync(planFile, serializePlan(plan(1)))
  const r = await capture(() => main(["shoot", planFile, "--offline", "--screenshot-dir", join(root, "s"), "--out", join(root, "o"), "--port", "1"], {}))
  expect(r.code).toBe(2)
  expect(r.err).toContain("-netconport 1")
})
