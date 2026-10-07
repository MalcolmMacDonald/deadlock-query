import { join } from "node:path"

/** What `bun run publish-map` is asked to do (flags of the one-command map publish; see `USAGE`). */
export interface PublishMapOptions {
  readonly map?: string
  readonly tier: "lite" | "full"
  /** Redo cached extractor stages and re-bake (`extract --force`, `bake --force`). */
  readonly force: boolean
  /** Existing bundle directory: skips `extract` (no game install needed), everything after it still runs. */
  readonly bundle?: string
  /** Stop after the Release upload and the pointer rewrite: no branch, commit or PR. */
  readonly noPr: boolean
  /** Print the steps without running anything. */
  readonly dryRun: boolean
}

export const USAGE = `bun run publish-map [--map <name>] [--tier lite|full] [--force] [--bundle <dir>] [--no-pr] [--dry-run]
  One command from the Deadlock install to a merged map update. Run it from the repo root on the laptop with the game
  (needs Source2Viewer, ~4 GB free, \`gh auth login\` and \`bun install\`). It:
    1. checks out main, pulls it and runs bun install (needs a clean working tree)
    2. extract -> tile -> bake -> inspect, pack-lite, check:real (stops at the first failure)
    3. zips the bundle and uploads it to the GitHub Release data-<buildId> (publish-data --upload)
    4. branches data/<buildId>, commits data/current-build.json, opens an [infra] PR assigned to you with auto-merge on
  Merging redeploys the dev site; prod moves on the next promote. Stages are cached, so running it again is cheap.
  --bundle <dir>  use an existing bundle and skip extract   --no-pr  stop after the upload   --dry-run  print the steps only`

export const parsePublishMapArgs = (argv: ReadonlyArray<string>): PublishMapOptions | { readonly error: string } => {
  let map: string | undefined, bundle: string | undefined, tier: "lite" | "full" = "lite"
  let force = false, noPr = false, dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`)
      return v
    }
    try {
      if (a === "--map") map = value()
      else if (a === "--bundle") bundle = value()
      else if (a === "--tier") {
        const t = value()
        if (t !== "lite" && t !== "full") return { error: `--tier must be lite or full, got ${t}` }
        tier = t
      }
      else if (a === "--force") force = true
      else if (a === "--no-pr") noPr = true
      else if (a === "--dry-run") dryRun = true
      else return { error: `unknown argument ${a}` }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (map !== undefined && !/^[0-9A-Za-z_-]+$/.test(map)) return { error: `unsafe map name ${map}` }
  return { ...(map !== undefined ? { map } : {}), tier, force, ...(bundle !== undefined ? { bundle } : {}), noPr, dryRun }
}

export interface Step {
  readonly name: string
  readonly cmd: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
}

/** `bun` running a repo script; `bun` is the running executable so Windows needs no PATH lookup. */
const bun = (bunPath: string, name: string, args: ReadonlyArray<string>, cwd?: string): Step => ({ name, cmd: bunPath, args, ...(cwd ? { cwd } : {}) })

const CLI = join("modules", "map-extractor", "src", "cli.ts")

/** Pulls the latest main first so the pointer change and the extractor code are current. Needs a clean tree (checked by the caller). */
export const syncSteps = (bunPath: string): ReadonlyArray<Step> => [
  { name: "check out main", cmd: "git", args: ["checkout", "main"] },
  { name: "pull main", cmd: "git", args: ["pull", "--ff-only", "origin", "main"] },
  bun(bunPath, "install dependencies", ["install"])
]

/** The extract command; prints `{ dir }` as JSON on stdout (progress goes to stderr). */
export const extractStep = (bunPath: string, o: PublishMapOptions): Step =>
  bun(bunPath, "extract", [CLI, "extract", "--tier", o.tier, "--keep-work", "--json", ...(o.map ? ["--map", o.map] : []), ...(o.force ? ["--force"] : [])])

/** tile (before bake: it rewrites the manifest), bake, the checks, then zip + upload and the pointer rewrite. */
export const buildSteps = (bunPath: string, o: PublishMapOptions, dir: string): ReadonlyArray<Step> => [
  bun(bunPath, "tile", [CLI, "tile", dir]),
  bun(bunPath, "bake", [CLI, "bake", dir, ...(o.force ? ["--force"] : [])]),
  bun(bunPath, "inspect", [CLI, "inspect", dir]),
  ...(o.tier === "lite" ? [bun(bunPath, "pack-lite check", [CLI, "pack-lite", dir])] : []),
  bun(bunPath, "check every file against the manifest", ["run", "check:real", "--", dir], join("modules", "contracts")),
  bun(bunPath, "zip, upload to the GitHub Release, update the pointer", [join("tools", "publish-data.ts"), dir, "--upload"])
]

export interface PointerPr {
  readonly branch: string
  readonly title: string
  readonly body: string
}

/** Branch, title and body of the PR that moves `data/current-build.json`; pointer-only PRs pass `check:scope` and `data.yml` re-verifies the asset. */
export const pointerPr = (info: { readonly buildId: string; readonly mapName: string; readonly tier: string }, sha256: string): PointerPr => ({
  branch: `data/${info.buildId}`,
  title: `[infra] Map data: ${info.mapName} build ${info.buildId} (${info.tier})`,
  body: [
    `Moves \`data/current-build.json\` to the ${info.tier} bundle of ${info.mapName} for game build ${info.buildId} (asset sha256 \`${sha256}\`).`,
    "",
    `Published by \`bun run publish-map\`: the zip is already on the Release \`data-${info.buildId}\`, and \`data.yml\` re-downloads it and checks hash and budgets.`,
    "Merging redeploys the dev site; prod moves on the next promote (see docs/runbook.md)."
  ].join("\n")
})
