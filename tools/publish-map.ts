import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { parsePointer } from "./lib/data.ts"
import { bundleFiles } from "./lib/publish.ts"
import { branchName, bundleDir, parsePublishMapArgs, planSteps, prBody, prTitle, PUBLISH_MAP_USAGE, type Step } from "./lib/publishMap.ts"
import { checkBundleReady } from "../modules/infra/src/bundleReady.ts"
import { locateGame } from "../modules/map-extractor/src/steam.ts"

/** `bun run publish-map`: the whole "publish a new map bundle" sequence of docs/dev-site.md as one command. */

const root = resolve(import.meta.dir, "..")
const POINTER = "data/current-build.json"
const total = { n: 0, of: 0 }

function die(msg: string, hint = "Fix that and run `bun run publish-map` again; stages that finished are cached."): never {
  console.error(`\n✗ ${msg}\n  ${hint}`)
  process.exit(1)
}

const say = (msg: string) => console.log(`\n▶ [${++total.n}/${total.of}] ${msg}`)

const exe = (c: string) => (c === "bun" ? process.execPath : c)

const sh = (cmd: readonly string[], cwd = ".") => spawnSync(exe(cmd[0]!), cmd.slice(1), { cwd: join(root, cwd), encoding: "utf8" })

/** Quiet command whose stdout we need; stops with the stderr on failure. */
const out = (what: string, cmd: readonly string[]): string => {
  const r = sh(cmd)
  if (r.status !== 0) die(`${what} failed: ${cmd.join(" ")}\n${(r.stderr || String(r.error ?? "")).trim()}`)
  return r.stdout.trim()
}

const runStep = (s: Step) => {
  say(s.name)
  const r = spawnSync(exe(s.cmd[0]!), s.cmd.slice(1), { cwd: join(root, s.cwd ?? "."), stdio: "inherit" })
  if (r.status !== 0) die(`step "${s.name}" failed${r.status === null ? ` (${r.error ?? "killed"})` : ` (exit ${r.status})`}.`)
}

const opts = parsePublishMapArgs(process.argv.slice(2))
if ("error" in opts) { console.error(`${opts.error}\n${PUBLISH_MAP_USAGE}`); process.exit(2) }

// Preflight: everything that can be wrong before a multi-minute export.
let game: ReturnType<typeof locateGame>
try { game = locateGame({ gameDir: opts.gameDir }) } catch (e) { die(`Deadlock install not found: ${(e as { remediation?: string }).remediation ?? (e as Error).message}`, "Pass --game-dir <path> or set DEADLOCK_DIR.") }
if (!game.buildId) die("game build id unknown (no appmanifest next to the install)", "Use the Steam install, or pass --game-dir pointing at it.")
const buildId = game.buildId
if (out("git branch", ["git", "branch", "--show-current"]) !== "main") die("not on main", "git switch main && git pull, then run it again.")
if (out("git status", ["git", "status", "--porcelain", "--untracked-files=no"])) die("the working tree has uncommitted changes", "Commit or stash them first: the PR must contain only the pointer file.")
out("git fetch", ["git", "fetch", "origin", "main"])
if (out("git rev-list", ["git", "rev-list", "--count", "HEAD..origin/main"]) !== "0") out("git pull", ["git", "pull", "--ff-only", "origin", "main"])
if (out("git rev-list", ["git", "rev-list", "--count", "origin/main..HEAD"]) !== "0") die("local main has commits that are not on origin/main", "Push or drop them first.")
if (!opts.dryRun && sh(["gh", "auth", "status"]).status !== 0) die("gh is not signed in", "Run `gh auth login`, or use --dry-run to stop before the upload.")

const dir = bundleDir(buildId)
const abs = join(root, dir)
const ready = existsSync(join(abs, "manifest.json")) && (await checkBundleReady(abs, bundleFiles(abs))).length === 0
console.log(`game build ${buildId}; bundle ${dir} is ${ready ? "complete" : "missing or incomplete"}${opts.dryRun ? " (dry run)" : ""}`)
const steps = planSteps(opts, buildId, ready, abs)
if (ready && !opts.rebuild) console.log("skipping extract, tile and bake (already done; --rebuild redoes them)")
total.of = steps.length + (opts.dryRun ? 0 : 2)

for (const s of steps) runStep(s)

const asset = parsePointer(JSON.parse(readFileSync(join(root, POINTER), "utf8"))).assets.find((a) => a.name.includes(`-${buildId}-`))
if (!asset) die(`${POINTER} has no asset for build ${buildId} after publish-data`)
const changed = sh(["git", "diff", "--quiet", POINTER]).status !== 0

if (opts.dryRun) {
  if (changed) out("restore pointer", ["git", "checkout", "--", POINTER])
  console.log(`\n✓ dry run ok: ${asset.name}\n  Nothing was uploaded or committed. Run \`bun run publish-map\` to upload it and open the PR.`)
  process.exit(0)
}
if (!changed) {
  console.log(`\n✓ ${POINTER} on main already points at ${asset.name}; nothing to open a PR for.`)
  process.exit(0)
}

const branch = branchName(buildId, asset)
const onRemote = sh(["git", "ls-remote", "--exit-code", "--heads", "origin", branch]).status === 0
say(`branch ${branch}`)
if (onRemote) {
  out("restore pointer", ["git", "checkout", "--", POINTER])
  console.log("already pushed by an earlier run; reusing it")
} else {
  out("git switch", ["git", "switch", "-C", branch])
  out("git add", ["git", "add", POINTER])
  out("git commit", ["git", "commit", "-m", prTitle(buildId, asset), "--", POINTER])
  out("git push", ["git", "push", "-u", "origin", branch])
}

say("pull request")
const existing = JSON.parse(out("gh pr list", ["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "url,state", "--limit", "1"])) as Array<{ url: string; state: string }>
let url = existing[0]?.url
if (existing[0]?.state === "MERGED") { out("back to main", ["git", "switch", "main"]); console.log(`\n✓ already merged: ${url}`); process.exit(0) }
if (!url) {
  url = out("gh pr create", ["gh", "pr", "create", "--base", "main", "--head", branch, "--title", prTitle(buildId, asset), "--body", prBody(buildId, asset), "--assignee", "@me"])
}
if (out("current branch", ["git", "branch", "--show-current"]) !== "main") out("back to main", ["git", "switch", "main"])
console.log(`\n✓ ${asset.name} uploaded; PR ${url}\n  Merging redeploys the dev site; promote to prod from Actions → deploy when ready.`)
