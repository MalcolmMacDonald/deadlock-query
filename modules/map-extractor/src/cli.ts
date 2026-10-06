#!/usr/bin/env bun
import { doctor } from "./doctor.ts"
import { EXIT } from "./errors.ts"
import { listMaps, locateGame } from "./steam.ts"
import { ExportFailed, GameNotFound, ToolMissing } from "./errors.ts"
import lock from "../tools.lock.json" with { type: "json" }
import { extract, type Tier } from "./extract.ts"
import { inspectBundle } from "./inspect.ts"
import { bunRunner } from "./s2v.ts"
import { findTool } from "./tool.ts"
import { join, resolve } from "node:path"

/** Repo-root `data/bundles`, independent of the cwd the CLI is launched from. */
const DEFAULT_OUT = resolve(import.meta.dir, "..", "..", "..", "data", "bundles")

const USAGE = `dlq-extract <command> [--json] [--game-dir <path>]
  doctor     check Deadlock install, build id and Source2Viewer CLI
  list-maps  maps present in the game paks
  extract    --map <name> [--tier full|lite] [--force] [--out <dir>] [--tri-budget <n>] [--keep-work]   (default map ${lock.game.mainMap}, tier lite, out <repo>/data/bundles)
  inspect    <bundle-dir>   validate manifest/entities against contracts, report sizes and frame sanity
(bake, pack-lite, diff: not implemented yet)`

export const main = (argv: ReadonlyArray<string>): number => {
  const [cmd, ...rest] = argv
  const json = rest.includes("--json")
  const gi = rest.indexOf("--game-dir")
  const gameDir = gi >= 0 ? rest[gi + 1] : undefined
  const out = (data: unknown, text: string) => console.log(json ? JSON.stringify(data, null, 2) : text)

  if (cmd === "doctor") {
    const r = doctor({ gameDir })
    out(r, r.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`).join("\n"))
    return r.ok ? EXIT.ok : EXIT.problem
  }
  if (cmd === "list-maps") {
    try {
      const maps = listMaps(locateGame({ gameDir }))
      out({ maps }, maps.join("\n"))
      return EXIT.ok
    } catch (e) {
      if (!(e instanceof GameNotFound)) throw e
      out({ error: e._tag, remediation: e.remediation }, e.remediation)
      return EXIT.problem
    }
  }
  console.error(USAGE)
  return cmd === undefined || cmd === "--help" ? EXIT.ok : EXIT.usage
}

const flag = (a: ReadonlyArray<string>, name: string): string | undefined => {
  const i = a.indexOf(name)
  return i >= 0 ? a[i + 1] : undefined
}

/** Async commands (`extract`, `inspect`); everything else goes through the sync `main`. */
export const mainAsync = async (argv: ReadonlyArray<string>): Promise<number> => {
  const [cmd, ...rest] = argv
  const json = rest.includes("--json")
  const emit = (data: unknown, text: string) => console.log(json ? JSON.stringify(data, null, 2) : text)
  if (cmd === "inspect") {
    const dir = rest.find((a) => !a.startsWith("--"))
    if (!dir) { console.error(USAGE); return EXIT.usage }
    const r = await inspectBundle(dir)
    emit(r, [...r.errors.map((e) => `✗ ${e}`), ...r.warnings.map((w) => `! ${w}`), ...Object.entries(r.info).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), r.ok ? "inspect ok" : "inspect failed"].join("\n"))
    return r.ok ? EXIT.ok : EXIT.problem
  }
  if (cmd === "extract") {
    const tier = (flag(rest, "--tier") ?? "lite") as Tier
    if (tier !== "full" && tier !== "lite") { console.error(USAGE); return EXIT.usage }
    try {
      const game = locateGame({ gameDir: flag(rest, "--game-dir") })
      const map = flag(rest, "--map") ?? lock.game.mainMap
      const tool = findTool()
      if (!tool.matchesPin) console.error(`! Source2Viewer-CLI ${tool.version ?? "unknown"} differs from pinned ${tool.pinnedVersion}`)
      if (!game.buildId) { console.error("Game build id unknown (no appmanifest); use the Steam install."); return EXIT.problem }
      const r = await extract({
        vpk: join(game.mapsDir, `${map}.vpk`), map, buildId: game.buildId, s2vVersion: tool.version ?? tool.pinnedVersion,
        tier, outRoot: flag(rest, "--out") ?? DEFAULT_OUT, runner: bunRunner(tool.path), force: rest.includes("--force"), keepWork: rest.includes("--keep-work"),
        lite: flag(rest, "--tri-budget") ? { triBudget: Number(flag(rest, "--tri-budget")) } : {},
        log: (m) => console.error(m)
      })
      emit({ dir: r.dir, warnings: r.warnings }, [`bundle: ${r.dir}`, ...r.warnings.map((w) => `! ${w}`)].join("\n"))
      return EXIT.ok
    } catch (e) {
      if (e instanceof GameNotFound || e instanceof ToolMissing) { emit({ error: e._tag, remediation: e.remediation }, e.remediation); return EXIT.problem }
      if (e instanceof ExportFailed) { emit({ error: e._tag, stage: e.stage, stderr: e.stderr }, `export failed at ${e.stage}: ${e.stderr}`); return EXIT.problem }
      throw e
    }
  }
  return main(argv)
}

if (import.meta.main) process.exit(await mainAsync(process.argv.slice(2)))
