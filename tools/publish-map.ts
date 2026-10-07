import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { parseBundleManifest } from "./lib/publish.ts"
import { buildSteps, extractStep, parsePublishMapArgs, pointerPr, syncSteps, USAGE, type Step } from "./lib/publishMap.ts"

/**
 * `bun run publish-map`: extract, tile, bake, check, upload and open the pointer PR in one go.
 * The steps themselves are in tools/lib/publishMap.ts; this file only runs them (docs/dev-site.md has the manual route).
 */
const POINTER = "data/current-build.json"

const fail = (msg: string): never => { console.error(`✗ ${msg}`); process.exit(1) }

const show = (s: Step) => `${s.cmd === process.execPath ? "bun" : s.cmd} ${s.args.join(" ")}${s.cwd ? `   (in ${s.cwd})` : ""}`

/** Runs a step with its output visible; returns stdout when `capture` is set. */
const run = (s: Step, capture = false): string => {
  console.error(`\n▶ ${s.name}\n  ${show(s)}`)
  const r = spawnSync(s.cmd, [...s.args], { cwd: s.cwd, encoding: "utf8", stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"] })
  if (r.status !== 0) fail(`${s.name} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`)
  return r.stdout ?? ""
}

/** `extract --json` prints `{ dir, warnings }` on stdout (progress goes to stderr). */
const bundleDirOf = (stdout: string): string => {
  try {
    const dir = (JSON.parse(stdout) as { dir?: unknown }).dir
    if (typeof dir === "string" && dir) return resolve(dir)
  } catch { /* falls through */ }
  return fail("extract did not report a bundle directory")
}

const git = (...args: string[]) => ({ name: `git ${args[0]}`, cmd: "git", args })
const out = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  return { ok: r.status === 0, text: (r.stdout ?? "").trim() }
}

if (import.meta.main) {
  if (process.argv.includes("--help")) { console.log(USAGE); process.exit(0) }
  const opts = parsePublishMapArgs(process.argv.slice(2))
  if ("error" in opts) { console.error(`${opts.error}\n\n${USAGE}`); process.exit(1) }
  const bunPath = process.execPath
  process.chdir(resolve(import.meta.dir, "..")) // the steps and the pointer path are relative to the repo root

  if (opts.dryRun) {
    const dir = opts.bundle ? resolve(opts.bundle) : "<bundle dir printed by extract>"
    const steps = [...syncSteps(bunPath), ...(opts.bundle ? [] : [extractStep(bunPath, opts)]), ...buildSteps(bunPath, opts, dir)]
    console.log(steps.map((s, i) => `${i + 1}. ${s.name}\n   ${show(s)}`).join("\n"))
    console.log(`${steps.length + 1}. ${opts.noPr ? "(--no-pr) stop here; data/current-build.json is rewritten but not committed" : "branch data/<buildId>, commit data/current-build.json, push, open an [infra] PR with auto-merge"}`)
    process.exit(0)
  }

  // Preconditions first, so nothing slow runs before an obvious problem.
  if (out("git", ["status", "--porcelain", "--untracked-files=no"]).text) fail("the working tree has uncommitted changes to tracked files; commit or stash them first")
  if (!out("gh", ["auth", "status"]).ok) fail("gh is not logged in (run `gh auth login`); it uploads the Release asset and opens the PR")

  for (const s of syncSteps(bunPath)) run(s)

  const dir = opts.bundle
    ? resolve(opts.bundle)
    : bundleDirOf(run(extractStep(bunPath, opts), true))
  for (const s of buildSteps(bunPath, opts, dir)) run(s)

  const info = parseBundleManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")))
  const pointer = JSON.parse(readFileSync(POINTER, "utf8")) as { assets: Array<{ dest: string; sha256: string }> }
  const sha = pointer.assets.find((a) => a.dest === `data/${info.mapName}`)?.sha256 ?? ""

  if (opts.noPr) {
    console.log(`\n✓ uploaded; ${POINTER} is rewritten but not committed (--no-pr). Open the pointer PR by hand (docs/dev-site.md step 7).`)
    process.exit(0)
  }
  if (!out("git", ["status", "--porcelain", POINTER]).text) {
    console.log(`\n✓ ${POINTER} already points at this exact bundle: nothing to commit, no PR needed.`)
    process.exit(0)
  }
  const pr = pointerPr(info, sha)
  run(git("checkout", "-B", pr.branch))
  run(git("add", POINTER))
  run(git("commit", "-m", pr.title))
  run(git("push", "-u", "origin", pr.branch))
  const url = run({ name: "open the PR", cmd: "gh", args: ["pr", "create", "--base", "main", "--head", pr.branch, "--title", pr.title, "--body", pr.body, "--assignee", "@me"] }, true).trim().split("\n").pop()!
  const auto = spawnSync("gh", ["pr", "merge", url, "--auto", "--merge"], { encoding: "utf8" })
  run(git("checkout", "main"))
  console.log(`\n✓ ${url}\n${auto.status === 0 ? "  auto-merge is on: it merges once CI is green and redeploys the dev site." : `  could not enable auto-merge (${(auto.stderr || "").trim()}); merge it when CI is green.`}\n  Prod moves on the next promote (Actions → deploy → Run workflow with promote).`)
}
