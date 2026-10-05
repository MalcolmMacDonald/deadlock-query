import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import lock from "../tools.lock.json" with { type: "json" }
import { GameNotFound } from "./errors.ts"
import { parseVdf, type Vdf } from "./vdf.ts"

export interface GameInstall {
  readonly root: string // .../steamapps/common/Deadlock
  readonly citadel: string // root/game/citadel
  readonly mapsDir: string
  readonly buildId: string | undefined
  readonly source: "--game-dir" | "DEADLOCK_DIR" | "steam"
}

const { steamAppId, installDir } = lock.game
const str = (v: string | Vdf | undefined): string | undefined => (typeof v === "string" ? v : undefined)

/** Default Steam roots per platform (Windows primary). */
export const defaultSteamRoots = (env: Record<string, string | undefined> = process.env, platform = process.platform): string[] => {
  if (platform === "win32") return [env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", env["ProgramFiles"] ?? "C:\\Program Files"].map((p) => join(p, "Steam"))
  const home = env["HOME"] ?? ""
  return platform === "darwin" ? [join(home, "Library/Application Support/Steam")] : [join(home, ".steam/steam"), join(home, ".local/share/Steam")]
}

/** Library folders (`steamapps` parents) that list the Deadlock app in `libraryfolders.vdf`. */
export const libraryPaths = (vdfText: string): Array<{ path: string; hasApp: boolean }> => {
  const lf = parseVdf(vdfText)["libraryfolders"]
  if (!lf || typeof lf === "string") return []
  return Object.values(lf).flatMap((e) => {
    if (typeof e === "string") return []
    const path = str(e["path"])
    const apps = e["apps"]
    return path ? [{ path, hasApp: typeof apps === "object" && String(steamAppId) in apps }] : []
  })
}

export const buildIdFromManifest = (acfText: string): string | undefined => str((parseVdf(acfText)["AppState"] as Vdf | undefined)?.["buildid"])

const fromRoot = (root: string, source: GameInstall["source"]): GameInstall | undefined => {
  const citadel = join(root, "game", "citadel")
  if (!existsSync(join(citadel, "gameinfo.gi"))) return undefined
  const acf = join(root, "..", "..", `appmanifest_${steamAppId}.acf`)
  let buildId: string | undefined
  try { buildId = buildIdFromManifest(readFileSync(acf, "utf8")) } catch { /* manifest optional for explicit dirs */ }
  return { root, citadel, mapsDir: join(citadel, "maps"), buildId, source }
}

export interface LocateOptions {
  readonly gameDir?: string | undefined
  readonly env?: Record<string, string | undefined>
  readonly steamRoots?: ReadonlyArray<string>
}

/** Resolve the install: `--game-dir`, then `DEADLOCK_DIR`, then Steam libraries. Throws `GameNotFound`. */
export const locateGame = (opts: LocateOptions = {}): GameInstall => {
  const env = opts.env ?? process.env
  const tried: string[] = []
  const explicit: Array<[string | undefined, GameInstall["source"]]> = [[opts.gameDir, "--game-dir"], [env["DEADLOCK_DIR"], "DEADLOCK_DIR"]]
  for (const [dir, source] of explicit) {
    if (!dir) continue
    tried.push(dir)
    const g = fromRoot(dir, source)
    if (g) return g
    throw new GameNotFound({ tried, remediation: `${source} is set to "${dir}" but game/citadel/gameinfo.gi is not there. Point it at the folder named "${installDir}" (inside steamapps/common).` })
  }
  for (const steam of opts.steamRoots ?? defaultSteamRoots(env)) {
    const vdf = join(steam, "steamapps", "libraryfolders.vdf")
    tried.push(vdf)
    let libs: ReturnType<typeof libraryPaths>
    try { libs = libraryPaths(readFileSync(vdf, "utf8")) } catch { continue }
    for (const lib of [...libs.filter((l) => l.hasApp), ...libs.filter((l) => !l.hasApp)]) {
      const g = fromRoot(join(lib.path, "steamapps", "common", installDir), "steam")
      if (g) return g
      tried.push(join(lib.path, "steamapps", "common", installDir))
    }
  }
  throw new GameNotFound({ tried, remediation: `Deadlock (Steam AppID ${steamAppId}) was not found. Install it via Steam, or pass --game-dir / set DEADLOCK_DIR to the "${installDir}" folder.` })
}

/** Playable maps: `*.vpk` in `game/citadel/maps`, minus known non-gameplay ones. */
const NON_GAMEPLAY = new Set(["start"])
export const listMaps = (g: GameInstall): string[] =>
  readdirSync(g.mapsDir).filter((f) => f.endsWith(".vpk")).map((f) => f.slice(0, -4)).filter((m) => !NON_GAMEPLAY.has(m)).sort()
