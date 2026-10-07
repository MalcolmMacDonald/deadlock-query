#!/usr/bin/env bun
import { doctor } from "./doctor.ts"
import { EXIT } from "./errors.ts"
import { listMaps, locateGame } from "./steam.ts"
import { ExportFailed, GameNotFound, ToolMissing } from "./errors.ts"
import lock from "../tools.lock.json" with { type: "json" }
import { extract, type Tier } from "./extract.ts"
import { bakeBundle, DEFAULT_CELL_SIZE, DEFAULT_EXCLUDE_LAYERS } from "./bake.ts"
import { bakeNavmesh, DEFAULT_NAV_AGENT, DEFAULT_NAV_EXCLUDE_LAYERS, type NavmeshOptions } from "./navmesh.ts"
import { inspectBundle } from "./inspect.ts"
import { packLite } from "./packLite.ts"
import { tileBundle } from "./tiling.ts"
import { bunRunner } from "./s2v.ts"
import { findTool } from "./tool.ts"
import { join, resolve } from "node:path"

/** Repo-root `data/bundles`, independent of the cwd the CLI is launched from. */
const DEFAULT_OUT = resolve(import.meta.dir, "..", "..", "..", "data", "bundles")

const USAGE = `dlq-extract <command> [--json] [--game-dir <path>]
  doctor     check Deadlock install, build id and Source2Viewer CLI
  list-maps  maps present in the game paks
  extract    --map <name> [--tier full|lite] [--force] [--out <dir>] [--tri-budget <n>] [--full-fraction <0..1>] [--keep-work] [--materials]   (default map ${lock.game.mainMap}, tier lite, out <repo>/data/bundles)
  inspect    <bundle-dir>   validate manifest/entities against contracts, report sizes and frame sanity
  tile       <bundle-dir> [--lods <n>] [--lod-ratio <r>] [--keep-textures]   lite tier: meshopt-compress tiles, add simplified LODs (<id>#lod<n>), drop textures
  bake       <bundle-dir> [--cell-size <n>] [--exclude-layers a,b] [--floor-source auto|game-nav|collision] [--force]   collision BVH + sample grid (floorHeight, interior, wallDistance) into <bundle>/baked, recorded in the manifest (default cell ${DEFAULT_CELL_SIZE}, excludes ${DEFAULT_EXCLUDE_LAYERS.join(",")}; floorHeight from the game's nav faces when the bundle has collision/walkable.nav),
             then the navmesh (baked/navmesh.bin + OBJ in <bundle>.qa/) unless --no-navmesh: from the game's nav faces (+ .navflowmap connections, --flow-hull <n>, default 0) when present, else Recast (force with --nav-source game|recast):
             [--agent-radius ${DEFAULT_NAV_AGENT.radius}] [--agent-height ${DEFAULT_NAV_AGENT.height}] [--agent-climb ${DEFAULT_NAV_AGENT.climb}] [--agent-slope ${DEFAULT_NAV_AGENT.slopeDegrees}] [--nav-cell-size 8] [--nav-cell-height 4] [--nav-tile-size 128] [--nav-exclude-layers ${DEFAULT_NAV_EXCLUDE_LAYERS.join(",")}] [--qa-dir <dir>|--no-qa]
  pack-lite  <bundle-dir>   validate lite bundle, check for textures, verify budget compliance
(diff: not implemented yet)`

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
  if (cmd === "pack-lite") {
    const dir = rest.find((a) => !a.startsWith("--"))
    if (!dir) { console.error(USAGE); return EXIT.usage }
    const r = await packLite(dir)
    const MB = 1024 * 1024
    const lines = [
      r.buildId && r.mapName ? `bundle: ${r.mapName} / build ${r.buildId}` : "no bundle info",
      `total: ${(r.sizes.totalBytes / MB).toFixed(1)} MB (budget: 900 MB)`,
      `tiles: ${r.sizes.tileCount}`,
      r.sizes.collisionBytes ? `collision: ${(r.sizes.collisionBytes / MB).toFixed(1)} MB` : "collision: none",
      r.sizes.textureFiles.length > 0 ? `textures: ${r.sizes.textureFiles.length} files, ${(r.sizes.textureBytes / MB).toFixed(1)} MB` : "textures: none (✓)",
      ...r.errors.map((e) => `✗ ${e}`),
      ...r.warnings.map((w) => `! ${w}`),
      r.ok ? "pack-lite ok" : "pack-lite failed"
    ]
    emit(r, lines.join("\n"))
    return r.ok ? EXIT.ok : EXIT.problem
  }
  if (cmd === "bake") {
    const dir = rest[0]?.startsWith("--") ? undefined : rest[0]
    if (!dir) { console.error(USAGE); return EXIT.usage }
    const cell = flag(rest, "--cell-size")
    const layers = flag(rest, "--exclude-layers")
    const r = await bakeBundle(dir, {
      ...(cell !== undefined ? { cellSize: Number(cell) } : {}),
      ...(layers !== undefined ? { excludeLayers: layers.split(",").filter(Boolean) } : {}),
      ...(flag(rest, "--floor-source") !== undefined ? { floorSource: flag(rest, "--floor-source") as "auto" | "game-nav" | "collision" } : {}),
      force: rest.includes("--force"), log: (m) => console.error(m)
    })
    const MB = 1048576
    const b = r.baked
    let nav: Awaited<ReturnType<typeof bakeNavmesh>> | undefined
    if (r.ok && !rest.includes("--no-navmesh")) {
      const num = (n: string) => (flag(rest, n) === undefined ? undefined : Number(flag(rest, n)))
      const agent = { radius: num("--agent-radius"), height: num("--agent-height"), climb: num("--agent-climb"), slopeDegrees: num("--agent-slope") }
      const navLayers = flag(rest, "--nav-exclude-layers")
      const qa = flag(rest, "--qa-dir")
      const defined = <K extends string>(o: Record<K, number | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [P in K]?: number }
      const navOpts: NavmeshOptions = {
        agent: defined(agent),
        ...defined({ cellSize: num("--nav-cell-size"), cellHeight: num("--nav-cell-height"), tileSize: num("--nav-tile-size") }),
        ...(navLayers !== undefined ? { excludeLayers: navLayers.split(",").filter(Boolean) } : {}),
        ...(rest.includes("--no-qa") ? { qaDir: false as const } : qa !== undefined ? { qaDir: qa } : {}),
        ...(flag(rest, "--nav-source") !== undefined ? { source: flag(rest, "--nav-source") as "auto" | "game" | "recast" } : {}),
        ...(num("--flow-hull") !== undefined ? { flowHull: num("--flow-hull")! } : {}),
        force: rest.includes("--force"), log: (m) => console.error(m)
      }
      nav = await bakeNavmesh(dir, navOpts)
    }
    const n = nav?.navmesh
    const ok = r.ok && (nav?.ok ?? true)
    emit({ ...r, ...(nav ? { navmeshReport: nav } : {}) }, [...r.errors.map((e) => `✗ ${e}`), ...r.warnings.map((w) => `! ${w}`),
      ...(nav ? [...nav.errors.map((e) => `✗ navmesh: ${e}`), ...nav.warnings.map((w) => `! navmesh: ${w}`)] : []),
      ...(n ? [
        `navmesh (${n.source ?? "recast"}): ${n.polygons} polygons, ${n.components} components (largest ${(n.largestComponentShare * 100).toFixed(1)}%${n.largestComponentShareWithLinks !== undefined ? `, ${(n.largestComponentShareWithLinks * 100).toFixed(1)}% with links` : ""}), ${n.links.count} links, ${(n.bytes / MB).toFixed(1)} MB${nav?.cached ? " [cached]" : ""}`,
        ...(nav?.qaFile ? [`navmesh QA export: ${nav.qaFile}`] : [])
      ] : []),
      ...(b ? [
        `bvh: ${b.bvh.triangles} triangles, ${(b.bvh.bytes / MB).toFixed(1)} MB`,
        `sample grid: ${b.sampleGrid.nx}x${b.sampleGrid.ny} cells of ${b.sampleGrid.cellSize}, channels ${b.sampleGrid.channels.join(", ")}, ${(b.sampleGrid.bytes / MB).toFixed(1)} MB, floor from ${b.floorSource ?? "collision"}${b.walkable ? ` (${b.walkable.coveredCells}/${b.walkable.totalCells} cells = ${((b.walkable.coveredCells / b.walkable.totalCells) * 100).toFixed(1)}% walkable)` : ""}`,
        `semanticsVersion ${b.semanticsVersion}${b.placeholder ? " (placeholder)" : ""}${r.cached ? " [cached]" : ""}`
      ] : []),
      ok ? "bake ok" : "bake failed"].join("\n"))
    return ok ? EXIT.ok : EXIT.problem
  }
  if (cmd === "tile") {
    const dir = rest[0]?.startsWith("--") ? undefined : rest[0] // first positional; later args are flags with values
    if (!dir) { console.error(USAGE); return EXIT.usage }
    const num = (n: string) => (flag(rest, n) === undefined ? undefined : Number(flag(rest, n)))
    const r = await tileBundle(dir, {
      ...(num("--lods") !== undefined ? { lods: num("--lods")! } : {}),
      ...(num("--lod-ratio") !== undefined ? { lodRatio: num("--lod-ratio")! } : {}),
      keepTextures: rest.includes("--keep-textures"), log: (m) => console.error(m)
    })
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`
    emit(r, [...r.errors.map((e) => `✗ ${e}`), ...r.warnings.map((w) => `! ${w}`),
      `${r.tiles.length} tile files, ${mb(r.bytesBefore)} before, ${mb(r.bytesAfter)} after (all LODs), largest ${mb(r.largestTileBytes)}`,
      r.ok ? "tile ok" : "tile failed"].join("\n"))
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
        tier, outRoot: flag(rest, "--out") ?? DEFAULT_OUT, runner: bunRunner(tool.path), force: rest.includes("--force"), keepWork: rest.includes("--keep-work"), materials: rest.includes("--materials"),
        lite: {
          ...(flag(rest, "--tri-budget") ? { triBudget: Number(flag(rest, "--tri-budget")) } : {}),
          ...(flag(rest, "--full-fraction") ? { fullFraction: Number(flag(rest, "--full-fraction")) } : {})
        },
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
