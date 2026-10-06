import lock from "../tools.lock.json" with { type: "json" }
import { GameNotFound, ToolMissing } from "./errors.ts"
import { locateGame, listMaps, type LocateOptions } from "./steam.ts"
import { findTool } from "./tool.ts"

export interface Check { readonly name: string; readonly ok: boolean; readonly detail: string; readonly fix?: string }

/** Run all checks; never throws. `ok` is false if any required check failed. */
export const doctor = (opts: LocateOptions & { run?: (p: string) => string } = {}): { ok: boolean; checks: Check[] } => {
  const checks: Check[] = []
  try {
    const g = locateGame(opts)
    checks.push({ name: "game", ok: true, detail: `${g.root} (via ${g.source})` })
    const tested = lock.game.testedBuildId
    checks.push(g.buildId === undefined
      ? { name: "build", ok: true, detail: "build id unknown (no appmanifest next to an explicit game dir)" }
      : { name: "build", ok: true, detail: g.buildId === tested ? `build ${g.buildId}` : `build ${g.buildId} is newer/different than last tested ${tested}; formats may have changed` })
    try {
      const maps = listMaps(g)
      const main = maps.includes(lock.game.mainMap)
      checks.push({ name: "maps", ok: main, detail: `${maps.length} maps: ${maps.join(", ")}`, ...(main ? {} : { fix: `expected ${lock.game.mainMap}.vpk in ${g.mapsDir}` }) })
    } catch (e) {
      checks.push({ name: "maps", ok: false, detail: `cannot read ${g.mapsDir}: ${(e as Error).message}` })
    }
  } catch (e) {
    if (!(e instanceof GameNotFound)) throw e
    checks.push({ name: "game", ok: false, detail: `not found (tried ${e.tried.length} locations)`, fix: e.remediation })
  }
  try {
    const t = findTool(undefined, opts.run)
    checks.push({ name: "source2viewer", ok: t.matchesPin, detail: `${t.path} version ${t.version ?? "unknown"} (pinned ${t.pinnedVersion})`, ...(t.matchesPin ? {} : { fix: `install the pinned ${t.pinnedVersion} (see tools.lock.json)` }) })
  } catch (e) {
    if (!(e instanceof ToolMissing)) throw e
    checks.push({ name: "source2viewer", ok: false, detail: "not found", fix: e.remediation })
  }
  return { ok: checks.every((c) => c.ok), checks }
}
