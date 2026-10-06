import { spawnSync } from "node:child_process"

export const LOCKFILE = "bun.lock"

export type LockfileResult =
  | { readonly status: "clean" }
  | { readonly status: "resolved" }
  | { readonly status: "blocked"; readonly files: ReadonlyArray<string> }

/** True when the lockfile is the only conflicted file, so regenerating it settles the merge. */
export const onlyLockfile = (conflicted: ReadonlyArray<string>): boolean =>
  conflicted.length > 0 && conflicted.every((f) => f === LOCKFILE)

const run = (cwd: string, cmd: string, args: string[]): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

export const conflictedFiles = (cwd: string): string[] =>
  run(cwd, "git", ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean)

/**
 * Settle a lockfile-only conflict during `git merge origin/main` into a PR branch.
 * Takes the base branch's lockfile ("theirs" in a merge), then `bun install` re-resolves it against the
 * already-merged package.json files, so both sides' dependency changes survive. Stages the result; the caller commits.
 * Any other conflicted file is left alone and reported as `blocked`.
 */
export const resolveLockfile = (cwd: string): LockfileResult => {
  const conflicted = conflictedFiles(cwd)
  if (conflicted.length === 0) return { status: "clean" }
  if (!onlyLockfile(conflicted)) return { status: "blocked", files: conflicted }
  run(cwd, "git", ["checkout", "--theirs", LOCKFILE])
  run(cwd, "bun", ["install"])
  run(cwd, "git", ["add", LOCKFILE])
  return { status: "resolved" }
}
