import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { GameConsole } from "./console.ts"
import { ConsoleError } from "./errors.ts"

export interface Check { readonly name: string; readonly ok: boolean; readonly detail: string; readonly fix?: string }

/** Launch options the tool needs. **[VERIFY]** against the real game (spike S3). */
export const LAUNCH_OPTIONS = (port: number): string => `-netconport ${port} -windowed -novid -insecure`

const PROCESS_NAMES = ["deadlock.exe", "deadlock"]

/** Lower-cased names of running processes; empty if the platform call fails. */
export const listProcesses = (platform: string = process.platform): string[] => {
  try {
    const out = platform === "win32"
      ? execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" }).split(/\r?\n/).map((l) => l.split('","')[0]?.replace(/^"/, "") ?? "")
      : execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" }).split("\n").map((l) => l.trim().split("/").pop() ?? "")
    return out.filter(Boolean).map((n) => n.toLowerCase())
  } catch {
    return []
  }
}

/** True while a Deadlock process exists. */
export const gameRunning = (processes: () => ReadonlyArray<string> = () => listProcesses()): boolean => processes().some((p) => PROCESS_NAMES.includes(p))

export interface DoctorOptions {
  readonly port: number
  /** Game install root (`.../steamapps/common/Deadlock`); screenshots land in `game/citadel/screenshots` **[VERIFY]**. */
  readonly gameDir?: string | undefined
  readonly screenshotDir?: string | undefined
  readonly processes?: () => ReadonlyArray<string>
}

export const screenshotDirOf = (o: Pick<DoctorOptions, "gameDir" | "screenshotDir">): string | undefined =>
  o.screenshotDir ?? (o.gameDir ? join(o.gameDir, "game", "citadel", "screenshots") : undefined)

/**
 * Run every check; never fails. `ok` is false if any check failed. The console probe goes through the
 * `GameConsole` service, so the same code runs against the real game and the fake.
 */
export const doctor = (o: DoctorOptions): Effect.Effect<{ ok: boolean; checks: Check[]; launchOptions: string }, never, GameConsole> =>
  Effect.gen(function* () {
    const checks: Check[] = []
    const running = gameRunning(o.processes)
    checks.push(running
      ? { name: "game-process", ok: true, detail: "Deadlock is running" }
      : { name: "game-process", ok: false, detail: "no Deadlock process found", fix: `start Deadlock offline with: ${LAUNCH_OPTIONS(o.port)}` })

    const gc = yield* GameConsole
    const probe = yield* gc.send("echo dlq-doctor").pipe(Effect.result)
    if (probe._tag === "Success") {
      checks.push(probe.success.includes("dlq-doctor")
        ? { name: "console", ok: true, detail: `console answered on port ${o.port}` }
        : { name: "console", ok: false, detail: `unexpected console reply: ${JSON.stringify(probe.success)}`, fix: "check the port belongs to Deadlock's -netconport" })
    } else {
      const e: ConsoleError = probe.failure
      checks.push({ name: "console", ok: false, detail: e.detail, fix: e.remediation })
    }

    const dir = screenshotDirOf(o)
    if (dir === undefined) {
      checks.push({ name: "screenshot-dir", ok: false, detail: "unknown", fix: "pass --game-dir <Deadlock install> or --screenshot-dir <dir>" })
    } else {
      const ok = existsSync(dir) && statSync(dir).isDirectory()
      checks.push({ name: "screenshot-dir", ok, detail: dir, ...(ok ? {} : { fix: "take one screenshot in-game (or create the folder) and re-run; override with --screenshot-dir" }) })
    }

    // Offline/sandbox mode cannot be confirmed from outside the game until spike S3 names a readable signal.
    checks.push({ name: "offline-mode", ok: true, detail: "not verified (no console signal known yet); only use this tool in an offline/sandbox session, never matchmaking" })
    return { ok: checks.every((c) => c.ok), checks, launchOptions: LAUNCH_OPTIONS(o.port) }
  })
