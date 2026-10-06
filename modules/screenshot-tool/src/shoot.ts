import { makeScreenshotSet, poseError, ScreenshotSet, Shot as ShotSchema, validateScreenshotSet, type Shot, type Vec3 } from "@deadlock-query/contracts"
import { Data, Effect, Queue, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import { GameConsole } from "./console.ts"
import type { ConsoleError } from "./errors.ts"
import { imageSize } from "./image.ts"
import { DEFAULT_THUMB_EDGE, makeThumbnail, thumbFile } from "./thumbs.ts"
import { shotAngles, type ShotPlan, type ShotSpec } from "./plan.ts"

export class ShootError extends Data.TaggedError("ShootError")<{
  readonly kind: "setup" | "pose" | "pickup" | "image" | "output" | "console" | "timeout" | "game-lost" | "plan"
  readonly shotId?: string
  readonly detail: string
  readonly remediation: string
}> {}

export type ShootProgress =
  | { readonly _tag: "start"; readonly total: number; readonly outDir: string }
  | { readonly _tag: "shot"; readonly index: number; readonly total: number; readonly id: string; readonly file: string }
  | { readonly _tag: "resumed"; readonly done: number; readonly total: number }
  | { readonly _tag: "retry"; readonly shotId: string; readonly attempt: number; readonly attempts: number; readonly reason: string }
  | { readonly _tag: "warning"; readonly shotId?: string; readonly message: string }
  | { readonly _tag: "done"; readonly total: number; readonly indexFile: string }

export interface ShootOptions {
  /** Folder the finished set is written to (`index.jsonl`, `index.json`, images). */
  readonly outDir: string
  /** Folder the game writes its screenshots to. */
  readonly screenshotDir: string
  readonly gameBuildId: string
  /** Wait after `setpos`/`setang` before capturing, for world streaming and LOD to settle. */
  readonly settleMs?: number
  /** How long to wait for a screenshot file to appear after the `screenshot` command. */
  readonly pickupTimeoutMs?: number
  readonly positionTolerance?: number
  readonly angleTolerance?: number
  /** Commands sent once before the first shot. Defaults to `sessionSetup(plan)`; pass `[]` to skip. */
  readonly setup?: ReadonlyArray<string>
  /** Write a JPEG thumbnail per shot to `<outDir>/thumbs/<id>.jpg` (default true). A thumbnail that cannot be made is a warning, not a failure. */
  readonly thumbnails?: boolean
  /** Longer edge of the thumbnails in pixels (default 320). */
  readonly thumbnailEdge?: number
  /** Replace an existing run in `outDir` instead of refusing. */
  readonly force?: boolean
  /** Continue the run in `outDir`: shots already in `index.jsonl` are kept and skipped. */
  readonly resume?: boolean
  /** Attempts per shot for failures that can pass on a second try: pose not honoured, no screenshot, console timeout, game briefly unreachable (default 3). */
  readonly attempts?: number
  /** Wait between attempts (default 1000). */
  readonly retryDelayMs?: number
  /** Time limit for one attempt at one shot (default 60000). */
  readonly shotTimeoutMs?: number
  /** Probe for "is the game process still alive", used to stop retrying once the game has exited. */
  readonly gameRunning?: () => boolean
  readonly placeholder?: boolean
  readonly onProgress?: (e: ShootProgress) => void
}

/** One-time session commands. **[VERIFY]** each against the real game (spike S3); the names are Source conventions, not confirmed for Deadlock. */
export const sessionSetup = (plan: Pick<ShotPlan, "fov" | "hideHud">): string[] => [
  `fov_desired ${plan.fov}`,
  `cl_drawhud ${plan.hideHud ? 0 : 1}`
]

export interface Pose { readonly position: Vec3; readonly angles: Vec3 }

const NUM = String.raw`(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)`
const POS = new RegExp(String.raw`setpos(?:_exact)?\s+${NUM}\s+${NUM}\s+${NUM}`, "i")
const ANG = new RegExp(String.raw`setang(?:_exact)?\s+${NUM}\s+${NUM}(?:\s+${NUM})?`, "i")

/** Parse a `getpos` reply (`setpos x y z;setang p y r`, also the `_exact` variants). **[VERIFY]** the real reply format. */
export const parseGetpos = (reply: string): Pose | undefined => {
  const p = POS.exec(reply), a = ANG.exec(reply)
  if (!p || !a) return undefined
  return { position: [Number(p[1]), Number(p[2]), Number(p[3])], angles: [Number(a[1]), Number(a[2]), a[3] === undefined ? 0 : Number(a[3])] }
}

const sleep = (ms: number) => ms > 0 ? Effect.sleep(ms) : Effect.void
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"])
const listImages = (dir: string): Map<string, number> => {
  const m = new Map<string, number>()
  if (!existsSync(dir)) return m
  for (const f of readdirSync(dir)) if (IMAGE_EXT.has(extname(f).toLowerCase())) m.set(f, statSync(join(dir, f)).mtimeMs)
  return m
}

/** Wait for a file that was not in `before` to appear and stop growing. */
const pickup = (dir: string, before: ReadonlyMap<string, number>, timeoutMs: number, shotId: string): Effect.Effect<string, ShootError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    let candidate: { name: string; size: number } | undefined
    while (Date.now() < deadline) {
      const now = listImages(dir)
      const fresh = [...now].filter(([n, t]) => before.get(n) !== t).map(([n]) => n).sort()
      const name = fresh[fresh.length - 1]
      if (name !== undefined) {
        const size = statSync(join(dir, name)).size
        if (candidate?.name === name && candidate.size === size && size > 0) return name
        candidate = { name, size }
      }
      yield* sleep(25)
    }
    return yield* new ShootError({ kind: "pickup", shotId, detail: `no new screenshot appeared in ${dir} within ${timeoutMs} ms`, remediation: "check --screenshot-dir is the folder the game writes to, and that the game window is not paused or minimised" })
  })

const consoleFail = (shotId: string | undefined, step: string) => (e: ConsoleError) =>
  new ShootError({
    kind: shotId === undefined ? "setup" : e.kind === "rejected" ? "console" : e.kind === "timeout" ? "timeout" : "game-lost",
    ...(shotId !== undefined ? { shotId } : {}),
    detail: `${step}: ${e.detail}`,
    remediation: e.remediation
  })

/** Failures a second attempt can fix. A refused command, a bad image or an output problem will fail the same way again. */
const RETRYABLE: ReadonlySet<ShootError["kind"]> = new Set(["pose", "pickup", "timeout", "game-lost"])

const RESUME_HINT = "restart the game offline with the same launch options, then re-run the same command with --resume"

const unknownCommand = (reply: string): boolean => /unknown command/i.test(reply)

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex")

const prepError = (e: unknown, outDir: string) =>
  e instanceof ShootError ? e : new ShootError({ kind: "output", detail: `cannot prepare ${outDir}: ${(e as Error).message}`, remediation: "check the folder exists and is writable" })

const samePose = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Shots of an earlier run that can be kept: parsed from `index.jsonl` (a half-written last line from a crash is dropped),
 * file still present with the recorded size, and requesting exactly the pose the plan now asks for. A shot whose id is in
 * the plan with a different pose, or no longer in the plan, means the plan changed under the run: that is an error, not a skip.
 */
const loadDone = (plan: ShotPlan, outDir: string, emit: (e: ShootProgress) => void): Shot[] => {
  const jsonl = join(outDir, "index.jsonl")
  if (!existsSync(jsonl)) return []
  const lines = readFileSync(jsonl, "utf8").split("\n").filter((l) => l.trim() !== "")
  const kept: Shot[] = []
  for (const [i, line] of lines.entries()) {
    let shot: Shot
    try { shot = Schema.decodeUnknownSync(ShotSchema)(JSON.parse(line)) } catch {
      if (i === lines.length - 1) { emit({ _tag: "warning", message: "dropped a half-written last line of index.jsonl; that shot is taken again" }); continue }
      throw new ShootError({ kind: "output", detail: `index.jsonl line ${i + 1} is not a shot`, remediation: "the index is damaged; re-run with --force to start over" })
    }
    const spec = plan.shots.find((p) => p.id === shot.id)
    if (spec === undefined || !samePose(spec.position, shot.requested.position) || !samePose(shotAngles(spec), shot.requested.angles)) {
      throw new ShootError({ kind: "plan", shotId: shot.id, detail: `shot "${shot.id}" in ${outDir} is not in the plan, or was taken for a different pose`, remediation: "the plan changed since the run started; re-run with --force to start over" })
    }
    const file = join(outDir, shot.file)
    if (!existsSync(file) || statSync(file).size !== shot.bytes) {
      emit({ _tag: "warning", shotId: shot.id, message: `${shot.file} is missing or changed; the shot is taken again` })
      continue
    }
    if (!kept.some((k) => k.id === shot.id)) kept.push(shot)
  }
  return kept
}

/**
 * Run a plan: session setup once, then per shot `setpos`/`setang` -> read back with `getpos` and verify -> settle ->
 * `screenshot` -> pick the new file out of the game's screenshot folder -> move it to `<outDir>/<id>.<ext>` -> append the
 * shot to `index.jsonl`. At the end `index.json` (a contracts `ScreenshotSet`) is written.
 *
 * Failures that a second try can fix are retried (`attempts`); the rest stop the run. `resume` keeps the shots already in
 * `index.jsonl`, so a run killed with the game can be finished after restarting it.
 */
export const shoot = (plan: ShotPlan, o: ShootOptions): Effect.Effect<ScreenshotSet, ShootError, GameConsole> =>
  Effect.gen(function* () {
    const gc = yield* GameConsole
    const emit = o.onProgress ?? (() => {})
    const jsonl = join(o.outDir, "index.jsonl")
    const posTol = o.positionTolerance ?? 8, angTol = o.angleTolerance ?? 1
    if (o.resume && o.force) return yield* new ShootError({ kind: "output", detail: "--resume and --force cannot be combined", remediation: "use --resume to continue the run, or --force to start over" })

    const done = yield* Effect.try({
      try: (): Shot[] => {
        mkdirSync(o.outDir, { recursive: true })
        mkdirSync(o.screenshotDir, { recursive: true })
        const existing = existsSync(jsonl) && statSync(jsonl).size > 0
        if (existing && !o.resume) {
          if (!o.force) throw new ShootError({ kind: "output", detail: `${o.outDir} already holds a run`, remediation: "pass --resume to continue it, or --force to start over" })
          rmSync(jsonl)
        }
        rmSync(join(o.outDir, "index.json"), { force: true })
        if (!o.resume) return []
        const kept = loadDone(plan, o.outDir, emit)
        // Rewrite the index from what was kept so the file is clean before new shots are appended.
        writeFileSync(jsonl, kept.map((k) => `${JSON.stringify(k)}\n`).join(""))
        return kept
      },
      catch: (e) => prepError(e, o.outDir)
    })

    emit({ _tag: "start", total: plan.shots.length, outDir: o.outDir })
    if (o.resume) emit({ _tag: "resumed", done: done.length, total: plan.shots.length })
    const doneIds = new Set(done.map((d) => d.id))
    const todo = plan.shots.filter((p) => !doneIds.has(p.id))

    if (todo.length > 0) {
      for (const cmd of o.setup ?? sessionSetup(plan)) {
        const reply = yield* gc.send(cmd).pipe(Effect.mapError(consoleFail(undefined, cmd)))
        if (unknownCommand(reply)) return yield* new ShootError({ kind: "setup", detail: `${cmd}: ${reply}`, remediation: "this game build does not know the command; see STATE.md for the commands verified so far" })
      }
    }

    const shots: Shot[] = [...done]
    for (const spec of todo) {
      const shot = yield* shootWithRetry(gc, plan, spec, o, { posTol, angTol }, emit)
      shots.push(shot)
      emit({ _tag: "shot", index: plan.shots.indexOf(spec), total: plan.shots.length, id: spec.id, file: shot.file })
    }

    const set = makeScreenshotSet({
      gameBuildId: o.gameBuildId, mapName: plan.map, fov: plan.fov, hideHud: plan.hideHud,
      ...(o.placeholder ? { placeholder: true } : {}),
      tool: { name: "dlq-shoot", version: pkg.version }
    }, shots)
    const problems = validateScreenshotSet(set, { positionTolerance: posTol, angleTolerance: angTol })
    if (problems.length > 0) return yield* new ShootError({ kind: "output", detail: problems.join("; "), remediation: "the run produced an invalid set; this is a bug in dlq-shoot" })
    const indexFile = join(o.outDir, "index.json")
    yield* Effect.try({
      try: () => writeFileSync(indexFile, `${JSON.stringify(Schema.encodeSync(ScreenshotSet)(set), null, 2)}\n`),
      catch: (e) => new ShootError({ kind: "output", detail: `cannot write ${indexFile}: ${(e as Error).message}`, remediation: "check the folder is writable" })
    })
    emit({ _tag: "done", total: shots.length, indexFile })
    return set
  })

/** Same run as a `Stream` of progress events; the stream fails with the `ShootError` that stopped the run, and ends after `done`. */
export const shootEvents = (plan: ShotPlan, o: ShootOptions): Stream.Stream<ShootProgress, ShootError, GameConsole> =>
  Stream.callback<ShootProgress, ShootError, GameConsole>((queue) =>
    Effect.gen(function* () {
      const result = yield* shoot(plan, { ...o, onProgress: (e) => { o.onProgress?.(e); Queue.offerUnsafe(queue, e) } }).pipe(Effect.result)
      if (result._tag === "Failure") yield* Queue.fail(queue, result.failure)
      else yield* Queue.end(queue)
    })
  )

const sleepFor = (ms: number) => (ms > 0 ? Effect.sleep(ms) : Effect.void)

/** One shot with a per-attempt time limit and retries for failures a second try can fix. */
const shootWithRetry = (
  gc: GameConsole["Service"], plan: ShotPlan, spec: ShotSpec, o: ShootOptions, tol: { posTol: number; angTol: number }, emit: (e: ShootProgress) => void
): Effect.Effect<Shot, ShootError> =>
  Effect.gen(function* () {
    const attempts = Math.max(1, o.attempts ?? 3)
    const limit = o.shotTimeoutMs ?? 60_000
    for (let n = 1; ; n++) {
      const r = yield* shootOne(gc, plan, spec, o, tol, emit).pipe(
        Effect.timeoutOrElse({ duration: limit, orElse: () => Effect.fail(new ShootError({ kind: "timeout", shotId: spec.id, detail: `one attempt took longer than ${limit} ms`, remediation: "the game may be frozen or paused; check the window" })) }),
        Effect.result
      )
      if (r._tag === "Success") return r.success
      const e = r.failure
      const gone = e.kind === "game-lost" && o.gameRunning?.() === false
      if (gone) return yield* new ShootError({ kind: "game-lost", shotId: spec.id, detail: `the game is no longer running (${e.detail})`, remediation: RESUME_HINT })
      if (!RETRYABLE.has(e.kind) || n >= attempts) {
        return yield* e.kind === "game-lost" ? new ShootError({ kind: "game-lost", shotId: spec.id, detail: e.detail, remediation: `${e.remediation}; if the game crashed, ${RESUME_HINT}` }) : e
      }
      emit({ _tag: "retry", shotId: spec.id, attempt: n, attempts, reason: e.detail })
      yield* sleepFor(o.retryDelayMs ?? 1000)
    }
  })

const shootOne = (
  gc: GameConsole["Service"], plan: ShotPlan, spec: ShotSpec, o: ShootOptions, tol: { posTol: number; angTol: number }, emit: (e: ShootProgress) => void
): Effect.Effect<Shot, ShootError> =>
  Effect.gen(function* () {
    const angles = shotAngles(spec)
    const send = (cmd: string) => gc.send(cmd).pipe(Effect.mapError(consoleFail(spec.id, cmd)))
    yield* send(`setpos ${spec.position.join(" ")}`)
    yield* send(`setang ${angles.join(" ")}`)

    const reply = yield* send("getpos")
    const actual = parseGetpos(reply)
    if (actual === undefined) {
      emit({ _tag: "warning", shotId: spec.id, message: `cannot read the pose back from getpos reply ${JSON.stringify(reply)}; pose not verified` })
    } else {
      const err = poseError({ requested: { position: spec.position, angles }, actual })!
      if (err.position > tol.posTol || err.angle > tol.angTol) {
        return yield* new ShootError({
          kind: "pose", shotId: spec.id,
          detail: `the game put the camera ${err.position.toFixed(1)} units and ${err.angle.toFixed(1)} degrees away from the requested pose`,
          remediation: "the game did not honour setpos/setang: enable noclip/cheats in an offline sandbox, or move the shot out of geometry"
        })
      }
    }

    yield* sleep(o.settleMs ?? 500)
    const before = listImages(o.screenshotDir)
    yield* send("screenshot")
    const name = yield* pickup(o.screenshotDir, before, o.pickupTimeoutMs ?? 10_000, spec.id)

    const ext = extname(name).toLowerCase() === ".jpeg" ? ".jpg" : extname(name).toLowerCase()
    const file = `${spec.id}${ext}`
    const bytes = yield* Effect.try({
      try: () => {
        renameSync(join(o.screenshotDir, name), join(o.outDir, file))
        return readFileSync(join(o.outDir, file))
      },
      catch: (e) => new ShootError({ kind: "output", shotId: spec.id, detail: `cannot move ${name} to ${o.outDir}: ${(e as Error).message}`, remediation: "check both folders are on this machine and writable" })
    })
    const size = imageSize(bytes)
    if (size === undefined) return yield* new ShootError({ kind: "image", shotId: spec.id, detail: `${name} is not a PNG or JPEG`, remediation: "set the game's screenshot format to JPEG or PNG" })
    if (size.width !== plan.resolution.width || size.height !== plan.resolution.height) {
      emit({ _tag: "warning", shotId: spec.id, message: `image is ${size.width}x${size.height}, the plan asked for ${plan.resolution.width}x${plan.resolution.height}` })
    }

    let thumbnail: string | undefined
    if (o.thumbnails !== false) {
      const thumb = makeThumbnail(bytes, o.thumbnailEdge ?? DEFAULT_THUMB_EDGE)
      if (thumb === undefined) emit({ _tag: "warning", shotId: spec.id, message: "could not make a thumbnail (image not decodable)" })
      else {
        thumbnail = thumbFile(spec.id)
        yield* Effect.try({
          try: () => { mkdirSync(join(o.outDir, "thumbs"), { recursive: true }); writeFileSync(join(o.outDir, thumbnail!), thumb) },
          catch: (e) => new ShootError({ kind: "output", shotId: spec.id, detail: `cannot write the thumbnail: ${(e as Error).message}`, remediation: "check the folder is writable" })
        })
      }
    }

    const shot: Shot = {
      id: spec.id,
      ...(spec.group !== undefined ? { group: spec.group } : {}),
      requested: { position: spec.position, angles },
      ...(actual !== undefined ? { actual } : {}),
      ...(spec.lookAt !== undefined ? { lookAt: spec.lookAt } : {}),
      file, ...(thumbnail !== undefined ? { thumbnail } : {}), bytes: bytes.length, sha256: sha256(bytes), width: size.width, height: size.height,
      capturedAt: new Date().toISOString()
    }
    yield* Effect.try({
      try: () => appendFileSync(join(o.outDir, "index.jsonl"), `${JSON.stringify(shot)}\n`),
      catch: (e) => new ShootError({ kind: "output", shotId: spec.id, detail: `cannot append to index.jsonl: ${(e as Error).message}`, remediation: "check the folder is writable" })
    })
    return shot
  })
