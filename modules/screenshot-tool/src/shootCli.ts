import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { DEFAULT_NETCON, GameConsole, NetConPort } from "./console.ts"
import { gameRunning, screenshotDirOf } from "./doctor.ts"
import { EXIT } from "./errors.ts"
import { makeFakeGame } from "./fake.ts"
import { parsePlan, PlanError } from "./plan.ts"
import { shoot, type ShootProgress } from "./shoot.ts"

/** Repo-root `data/screenshots`, independent of the cwd the CLI is launched from. */
const DEFAULT_OUT = resolve(import.meta.dir, "..", "..", "..", "data", "screenshots")

export const SHOOT_USAGE = `dlq-shoot shoot <plan.json> [options]   run a plan against the game, write a ScreenshotSet
  --offline                 required with the real game: you confirm it runs offline/sandbox, never matchmaking
  --fake                    use the in-memory fake game (placeholder images, no --offline needed)
  --screenshot-dir <dir>    folder the game writes screenshots to (or --game-dir <Deadlock install>, or DEADLOCK_DIR)
  --out <dir>               output folder (default <repo>/data/screenshots/<gameBuildId>)
  --build <gameBuildId>     overrides the plan's gameBuildId
  --no-thumbnails           skip the JPEG thumbnails (thumbs/<id>.jpg)
  --force                   replace an existing run in the output folder
  --resume                  continue the run in the output folder: shots already taken are kept (use after a crash or Ctrl-C)
  --json                    print progress as one JSON event per line on stdout instead of text on stderr
  --settle-ms <n> (500)  --timeout-ms <n> (10000, wait for the screenshot file)  --attempts <n> (3, per shot)  --retry-delay-ms <n> (1000)
  --host <h>  --port <n> (${DEFAULT_NETCON.port}, or DLQ_CONSOLE_PORT)`

const int = (s: string | undefined, fallback: number, what: string): number => {
  if (s === undefined) return fallback
  const v = Number(s)
  if (!Number.isInteger(v) || v < 0) throw new PlanError([`${what} must be a non-negative integer, got "${s}"`])
  return v
}

export const shootMain = async (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = process.env): Promise<number> => {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        offline: { type: "boolean" }, fake: { type: "boolean" }, force: { type: "boolean" }, resume: { type: "boolean" }, "no-thumbnails": { type: "boolean" }, json: { type: "boolean" },
        "screenshot-dir": { type: "string" }, "game-dir": { type: "string" }, out: { type: "string" }, build: { type: "string" },
        "settle-ms": { type: "string" }, "timeout-ms": { type: "string" }, attempts: { type: "string" }, "retry-delay-ms": { type: "string" }, host: { type: "string" }, port: { type: "string" }
      }
    })
    const [file] = positionals
    if (!file) { console.error(SHOOT_USAGE); return EXIT.usage }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, "utf8")) } catch (e) { throw new PlanError([`cannot read ${file}: ${(e as Error).message}`]) }
    const plan = parsePlan(raw)

    const fake = values.fake === true
    if (!fake && !values.offline) {
      console.error("✗ refusing to drive the real game without --offline. Only use this tool in an offline/sandbox session, never in matchmaking.")
      return EXIT.usage
    }
    const port = int(values.port ?? env["DLQ_CONSOLE_PORT"], DEFAULT_NETCON.port, "port")
    const gameBuildId = values.build ?? plan.gameBuildId ?? (fake ? "fake" : undefined)
    if (gameBuildId === undefined) throw new PlanError(["the plan has no gameBuildId; pass --build <id> (the Steam build id of the running game)"])

    let screenshotDir = screenshotDirOf({ gameDir: values["game-dir"] ?? env["DEADLOCK_DIR"], screenshotDir: values["screenshot-dir"] })
    let layer: Layer.Layer<GameConsole>
    if (fake) {
      screenshotDir ??= mkdtempSync(join(tmpdir(), "dlq-fake-shots-"))
      layer = makeFakeGame({ screenshotDir, imageSize: plan.resolution }).layer
    } else {
      if (screenshotDir === undefined) throw new PlanError(["pass --screenshot-dir <dir> or --game-dir <Deadlock install> (run doctor to check)"])
      layer = NetConPort({ host: values.host ?? DEFAULT_NETCON.host, port })
    }

    const json = values.json === true
    const onProgress = (e: ShootProgress) => {
      if (json) console.log(JSON.stringify(e))
      else if (e._tag === "start") console.error(`shooting ${e.total} shots into ${e.outDir}`)
      else if (e._tag === "shot") console.error(`[${e.index + 1}/${e.total}] ${e.id} -> ${e.file}`)
      else if (e._tag === "resumed") console.error(`resuming: ${e.done} of ${e.total} shots already taken`)
      else if (e._tag === "retry") console.error(`! ${e.shotId}: attempt ${e.attempt}/${e.attempts} failed (${e.reason}); retrying`)
      else if (e._tag === "warning") console.error(`! ${e.shotId ? `${e.shotId}: ` : ""}${e.message}`)
    }
    const set = await Effect.runPromise(shoot(plan, {
      outDir: resolve(values.out ?? join(DEFAULT_OUT, gameBuildId)),
      screenshotDir, gameBuildId,
      settleMs: int(values["settle-ms"], fake ? 0 : 500, "settle-ms"),
      pickupTimeoutMs: int(values["timeout-ms"], 10_000, "timeout-ms"),
      thumbnails: values["no-thumbnails"] !== true, force: values.force === true, resume: values.resume === true, placeholder: fake, onProgress,
      attempts: int(values.attempts, 3, "attempts"), retryDelayMs: int(values["retry-delay-ms"], 1000, "retry-delay-ms"),
      ...(fake ? {} : { gameRunning: () => gameRunning() })
    }).pipe(Effect.provide(layer), Effect.result))
    if (set._tag === "Failure") {
      const e = set.failure
      if (json) console.log(JSON.stringify({ _tag: "failed", kind: e.kind, shotId: e.shotId, detail: e.detail, remediation: e.remediation }))
      console.error(`✗ ${e.shotId ? `${e.shotId}: ` : ""}${e.detail}\n  fix: ${e.remediation}`)
      return EXIT.problem
    }
    if (!json) console.log(`wrote ${set.success.shots.length} shots${fake ? " (placeholder images)" : ""}`)
    return EXIT.ok
  } catch (e) {
    if (e instanceof PlanError) { console.error(e.problems.map((p) => `✗ ${p}`).join("\n")); return EXIT.problem }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) { console.error(`${(e as Error).message}\n${SHOOT_USAGE}`); return EXIT.usage }
    throw e
  }
}
