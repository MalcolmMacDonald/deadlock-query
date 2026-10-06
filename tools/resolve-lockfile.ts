import { resolveLockfile } from "./lib/lockfile.ts"

/**
 * `bun tools/resolve-lockfile.ts [--commit]` — run inside a PR branch after `git merge origin/main` stopped on a
 * `bun.lock` conflict. Regenerates the lockfile from the merged package.json files. Exit 1 if other files conflict.
 */
if (import.meta.main) {
  const result = resolveLockfile(process.cwd())
  if (result.status === "blocked") {
    console.error(`not resolving: other files conflict too: ${result.files.join(", ")}`)
    process.exit(1)
  }
  if (result.status === "clean") console.log("no conflicts; nothing to do")
  else {
    console.log("bun.lock regenerated and staged")
    if (process.argv.includes("--commit")) {
      const r = Bun.spawnSync(["git", "commit", "--no-edit"])
      if (r.exitCode !== 0) { console.error(r.stderr.toString()); process.exit(1) }
    }
  }
}
