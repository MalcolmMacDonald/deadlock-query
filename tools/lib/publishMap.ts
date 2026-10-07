import type { DataAsset } from "./data.ts"

export interface PublishMapOptions {
  /** Build, validate and zip, but do not upload, push or open a PR (and leave `data/current-build.json` as it was). */
  readonly dryRun: boolean
  /** Run extract, tile and bake even when the bundle for this game build is already complete. */
  readonly rebuild: boolean
  /** `--force` for extract and bake (implies `rebuild`). */
  readonly force: boolean
  readonly map?: string
  readonly gameDir?: string
}

export interface Step {
  readonly name: string
  /** `bun` stands for the running bun binary; everything else is looked up on PATH. */
  readonly cmd: readonly string[]
  /** Relative to the repo root. */
  readonly cwd?: string
}

export const PUBLISH_MAP_USAGE = `bun run publish-map [--dry-run] [--rebuild] [--force] [--map <name>] [--game-dir <path>]
  Extract, tile, bake, validate, upload and open the pointer PR for the current game build, in one go. Run it from the repo
  root on the machine with the Deadlock install, on main with a clean tree and \`gh auth login\` done. Stops on the first
  failure; run it again to continue (finished stages are cached).
  --dry-run   do everything up to and including the zip, then stop (no upload, branch, push or PR; the pointer file is restored)
  --rebuild   run extract, tile and bake even if the bundle is already complete (use after changing extractor or semantics code)
  --force     --rebuild, and redo every extract stage and the bake from scratch
  --map, --game-dir  passed to extract`

export const parsePublishMapArgs = (argv: readonly string[]): PublishMapOptions | { readonly error: string } => {
  let dryRun = false, rebuild = false, force = false
  let map: string | undefined, gameDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--dry-run") dryRun = true
    else if (a === "--rebuild") rebuild = true
    else if (a === "--force") force = true
    else if (a === "--map" || a === "--game-dir") {
      const v = argv[++i]
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` }
      if (a === "--map") map = v; else gameDir = v
    } else return { error: `unknown argument ${a}` }
  }
  if (map !== undefined && !/^[0-9A-Za-z_-]+$/.test(map)) return { error: `unsafe map name ${map}` }
  return { dryRun, rebuild: rebuild || force, force, ...(map ? { map } : {}), ...(gameDir ? { gameDir } : {}) }
}

/** Bundle dir (relative to the repo root, forward slashes) the extractor writes for a game build. */
export const bundleDir = (buildId: string, tier = "lite") => `data/bundles/${buildId}/${tier}`

/**
 * The shell-out steps, in order. `bundleReady` says the bundle already passes the publish checks (tiled, baked, every file
 * matches the manifest), in which case the three build steps are skipped: `extract` rewrites `manifest.json` and would
 * throw the tile and bake records away, so running it on a finished bundle only redoes work.
 */
export const planSteps = (o: PublishMapOptions, buildId: string, bundleReady: boolean, contractsRealPath: string): Step[] => {
  const dir = bundleDir(buildId)
  const cli = ["bun", "modules/map-extractor/src/cli.ts"]
  const build: Step[] = o.rebuild || !bundleReady ? [
    { name: "extract", cmd: [...cli, "extract", "--tier", "lite", "--keep-work", ...(o.map ? ["--map", o.map] : []), ...(o.gameDir ? ["--game-dir", o.gameDir] : []), ...(o.force ? ["--force"] : [])] },
    { name: "tile", cmd: [...cli, "tile", dir] },
    { name: "bake", cmd: [...cli, "bake", dir, ...(o.force ? ["--force"] : [])] }
  ] : []
  return [
    ...build,
    { name: "inspect", cmd: [...cli, "inspect", dir] },
    { name: "pack-lite", cmd: [...cli, "pack-lite", dir] },
    { name: "check:real", cmd: ["bun", "scripts/check-real.ts", contractsRealPath], cwd: "modules/contracts" },
    { name: o.dryRun ? "zip (dry run)" : "upload", cmd: ["bun", "tools/publish-data.ts", dir, ...(o.dryRun ? [] : ["--upload", "--skip-existing"])] }
  ]
}

export const branchName = (buildId: string, asset: DataAsset) => `data/${buildId}-${asset.sha256.slice(0, 12)}`

export const prTitle = (buildId: string, asset: DataAsset) => `Publish map data ${buildId} (${asset.sha256.slice(0, 12)})`

export const prBody = (buildId: string, asset: DataAsset) =>
  `Moves \`data/current-build.json\` to \`${asset.name}\` (game build ${buildId}).\n\n` +
  `- sha256: \`${asset.sha256}\`\n- Release: \`data-${buildId}\` (asset uploaded before this PR was opened, so \`main\` keeps working until it merges)\n\n` +
  `\`data.yml\` re-downloads the asset and checks hash and budgets; merging redeploys the dev site. Prod moves on the next promote.\n\n` +
  `Opened by \`bun run publish-map\`.`
