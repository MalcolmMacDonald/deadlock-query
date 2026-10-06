import { expect, test } from "bun:test"
import jpeg from "jpeg-js"
import { Effect } from "effect"
import { PNG } from "pngjs"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/cli.ts"
import { makeFakeGame } from "../src/fake.ts"
import { imageSize } from "../src/image.ts"
import { ringPlan } from "../src/plan.ts"
import { shoot, type ShootProgress } from "../src/shoot.ts"
import { makeThumbnail } from "../src/thumbs.ts"
import { verifySet } from "../src/verify.ts"

const plan = (yaws = 3) => ringPlan({ map: "m", gameBuildId: "7", resolution: { width: 640, height: 360 } }, { at: [[100, 200, 50]], yaws })

/** A real run against the fake game: 3 shots with thumbnails in a fresh folder. */
const makeSet = async (extra: { thumbnails?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "dlq-verify-"))
  const out = join(root, "set"), shots = join(root, "game")
  const game = makeFakeGame({ screenshotDir: shots, imageSize: { width: 640, height: 360 } })
  const events: ShootProgress[] = []
  const r = await Effect.runPromise(shoot(plan(), { outDir: out, screenshotDir: shots, gameBuildId: "7", settleMs: 0, retryDelayMs: 0, placeholder: true, onProgress: (e) => events.push(e), ...extra }).pipe(Effect.provide(game.layer), Effect.result))
  if (r._tag === "Failure") throw new Error(r.failure.detail)
  return { out, set: r.success, events }
}
const readIndex = (out: string) => JSON.parse(readFileSync(join(out, "index.json"), "utf8"))
const writeIndex = (out: string, f: (j: any) => void) => { const j = readIndex(out); f(j); writeFileSync(join(out, "index.json"), JSON.stringify(j, null, 2)) }

test("thumbnails: PNG and JPEG inputs are downscaled to the longer edge, small images are not upscaled", () => {
  const rgb = new PNG({ width: 800, height: 400 })
  for (let i = 0; i < rgb.data.length; i += 4) { rgb.data[i] = (i / 4) % 256; rgb.data[i + 1] = 80; rgb.data[i + 2] = 200; rgb.data[i + 3] = 255 }
  const png = PNG.sync.write(rgb)
  expect(imageSize(makeThumbnail(png, 320)!)).toEqual({ width: 320, height: 160, format: "jpeg" })
  const jpg = jpeg.encode({ width: 300, height: 600, data: Buffer.alloc(300 * 600 * 4, 200) }, 80).data
  expect(imageSize(makeThumbnail(jpg, 100)!)).toEqual({ width: 50, height: 100, format: "jpeg" })
  expect(imageSize(makeThumbnail(jpg, 1000)!)).toEqual({ width: 300, height: 600, format: "jpeg" })
  expect(makeThumbnail(new Uint8Array([1, 2, 3]))).toBeUndefined()
  expect(makeThumbnail(png.subarray(0, 40))).toBeUndefined() // truncated PNG
})

test("a thumbnail keeps the picture: a half-dark image stays half-dark", () => {
  const img = new PNG({ width: 400, height: 200 })
  for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) { const i = (y * 400 + x) * 4; const v = x < 200 ? 0 : 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255 }
  const t = jpeg.decode(makeThumbnail(PNG.sync.write(img), 100)!, { useTArray: true })
  expect(t.data[(25 * 100 + 5) * 4]!).toBeLessThan(40)
  expect(t.data[(25 * 100 + 95) * 4]!).toBeGreaterThan(215)
})

test("shoot writes thumbnails and records them; --no-thumbnails style option skips them", async () => {
  const { out, set } = await makeSet()
  expect(set.shots.every((s) => s.thumbnail === `thumbs/${s.id}.jpg`)).toBe(true)
  for (const s of set.shots) expect(imageSize(readFileSync(join(out, s.thumbnail!)))).toMatchObject({ width: 320, height: 180 })
  const none = await makeSet({ thumbnails: false })
  expect(none.set.shots.every((s) => s.thumbnail === undefined)).toBe(true)
  expect(existsSync(join(none.out, "thumbs"))).toBe(false)
})

test("verify: a fresh run is clean apart from the placeholder note", async () => {
  const { out } = await makeSet()
  const r = verifySet(out)
  expect(r.errors).toEqual([])
  expect(r.ok).toBe(true)
  expect(r.warnings).toEqual([expect.stringContaining("placeholder set")])
  expect(r.info).toMatchObject({ shots: 3, gameBuildId: "7", mapName: "m", placeholder: true })
})

test("verify flags a tampered image (same size), a changed size, a missing image and wrong pixel size", async () => {
  const { out, set } = await makeSet()
  const [a, b, c] = set.shots
  const bytes = readFileSync(join(out, a!.file))
  bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff
  writeFileSync(join(out, a!.file), bytes)
  appendFileSync(join(out, b!.file), "x")
  rmSync(join(out, c!.file))
  const r = verifySet(out)
  expect(r.ok).toBe(false)
  expect(r.errors).toEqual([
    expect.stringContaining(`"${a!.id}"`),
    expect.stringContaining(`"${b!.id}"`),
    expect.stringContaining(`"${c!.id}": ${c!.file} is missing`)
  ])
  expect(r.errors[0]).toContain("sha256")
  expect(r.errors[1]).toContain("changed")

  const fresh = await makeSet()
  writeIndex(fresh.out, (j) => { j.shots[0].width = 1280 })
  expect(verifySet(fresh.out).errors[0]).toContain("640x360, the index says 1280x360")
})

test("verify checks poses, build id, map, paths and index problems", async () => {
  const { out, set } = await makeSet()
  writeIndex(out, (j) => { j.shots[1].actual.position[0] += 500; j.shots[2].file = "../escape.png" })
  const r = verifySet(out, { expect: { gameBuildId: "8", mapName: "other" } })
  expect(r.errors.some((e) => e.includes("gameBuildId") && e.includes("8"))).toBe(true)
  expect(r.errors.some((e) => e.includes("mapName"))).toBe(true)
  expect(r.errors.some((e) => e.includes(`"${set.shots[1]!.id}"`) && e.includes("units off the requested pose"))).toBe(true)
  expect(r.errors.some((e) => e.includes("leaves the set folder"))).toBe(true)
  // a larger tolerance accepts the same drift
  const lenient = verifySet(out, { positionTolerance: 1000 })
  expect(lenient.errors.some((e) => e.includes("units off"))).toBe(false)

  const dir = mkdtempSync(join(tmpdir(), "dlq-verify-bad-"))
  expect(verifySet(dir).errors[0]).toContain("not found")
  writeFileSync(join(dir, "index.json"), "{")
  expect(verifySet(dir).errors[0]).toContain("not valid JSON")
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: "2.0.0" }))
  expect(verifySet(dir).errors[0]).toContain("unsupported schemaVersion")
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: "1.0.0", shots: "no" }))
  expect(verifySet(dir).errors[0]).toContain("not a ScreenshotSet")
})

test("verify warns about missing thumbnails, unrecorded poses and stray files; thumbs repairs the thumbnails", async () => {
  const { out, set } = await makeSet()
  rmSync(join(out, set.shots[0]!.thumbnail!))
  writeFileSync(join(out, "stray.png"), "x")
  writeFileSync(join(out, "thumbs", "orphan.jpg"), "x")
  writeIndex(out, (j) => { delete j.shots[1].actual })
  const r = verifySet(out)
  expect(r.ok).toBe(true)
  expect(r.warnings.some((w) => w.includes("thumbnail thumbs/") && w.includes("missing"))).toBe(true)
  expect(r.warnings.some((w) => w.includes("stray.png is not part of the set"))).toBe(true)
  expect(r.warnings.some((w) => w.includes("thumbs/orphan.jpg is not part of the set"))).toBe(true)
  expect(r.warnings.some((w) => w.includes("unverified"))).toBe(true)
})

const capture = async (f: () => Promise<number>) => {
  const err: string[] = [], out: string[] = []
  const e = console.error, l = console.log
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  try { return { code: await f(), err: err.join("\n"), out: out.join("\n") } } finally { console.error = e; console.log = l }
}

test("cli: verify exit codes and --json; thumbs makes missing ones and --force redoes all", async () => {
  const { out, set } = await makeSet()
  const ok = await capture(() => main(["verify", out, "--build", "7", "--map", "m"], {}))
  expect(ok.code).toBe(0)
  expect(ok.out).toContain("verify ok: 3 shots")
  const json = await capture(() => main(["verify", out, "--json"], {}))
  expect(JSON.parse(json.out)).toMatchObject({ ok: true, info: { shots: 3 } })

  rmSync(join(out, set.shots[0]!.thumbnail!))
  rmSync(join(out, set.shots[1]!.thumbnail!))
  expect((await capture(() => main(["thumbs", out], {}))).out).toContain("made 2 thumbnails")
  expect(verifySet(out).warnings).toEqual([expect.stringContaining("placeholder set")])
  expect((await capture(() => main(["thumbs", out], {}))).out).toContain("made 0 thumbnails")
  expect((await capture(() => main(["thumbs", out, "--force", "--size", "100"], {}))).out).toContain("made 3 thumbnails")
  expect(imageSize(readFileSync(join(out, set.shots[0]!.thumbnail!)))).toMatchObject({ width: 100, height: 56 })

  rmSync(join(out, set.shots[2]!.file))
  const bad = await capture(() => main(["verify", out], {}))
  expect(bad.code).toBe(2)
  expect(bad.out).toContain("is missing")
  expect(bad.out).toContain("verify failed: 1 problem")
  expect((await capture(() => main(["thumbs", out, "--force"], {}))).code).toBe(2) // one image is gone

  expect((await capture(() => main(["verify"], {}))).code).toBe(1)
  expect((await capture(() => main(["verify", out, "--position-tolerance", "-1"], {}))).code).toBe(1)
  expect((await capture(() => main(["thumbs", join(out, "nope")], {}))).code).toBe(2)
})

test("cli: shoot --no-thumbnails", async () => {
  const root = mkdtempSync(join(tmpdir(), "dlq-nothumb-"))
  const planFile = join(root, "plan.json"), out = join(root, "out")
  const { serializePlan } = await import("../src/plan.ts")
  writeFileSync(planFile, serializePlan(ringPlan({ map: "m", gameBuildId: "7", resolution: { width: 64, height: 36 } }, { at: [[0, 0, 0]], yaws: 1 })))
  expect((await capture(() => main(["shoot", planFile, "--fake", "--out", out, "--no-thumbnails"], {}))).code).toBe(0)
  expect(existsSync(join(out, "thumbs"))).toBe(false)
  expect((await capture(() => main(["shoot", planFile, "--fake", "--out", out, "--force"], {}))).code).toBe(0)
  expect(existsSync(join(out, "thumbs"))).toBe(true)
})
