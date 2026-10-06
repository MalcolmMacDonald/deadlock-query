# Dry-run record

Rehearsals of the M7 procedures. "Run" means executed against this repo; "Needs Malcolm" means it can only be done with repo/Cloudflare settings or workflow dispatch.

## 2026-10-06 (infra M7)
| Procedure | Result |
|---|---|
| `claude/*` branch touching `semantics/**` is rejected | Run. Local branch `claude/dry-run` editing `modules/spatial-core/src/semantics/index.ts`, then `bun run check:scope -- --base origin/main --branch claude/dry-run --infra`: exit 1, `✗ claude/* branches may not touch owner-written semantics: modules/spatial-core/src/semantics/index.ts`. Same command CI runs; unit test in `modules/infra/test/checks.test.ts`. |
| Lockfile conflict resolution | Run in a throwaway workspace repo and covered by `modules/infra/test/lockfile.test.ts`: two branches add different workspace deps to one package, `git merge` stops on `bun.lock` only, `bun tools/resolve-lockfile.ts` regenerates it with both deps, `bun install --frozen-lockfile` passes. A second conflicting file makes it refuse. |
| Data pointer gate | Run. `bun tools/check-data.ts` on the committed pointer downloaded the real `data-25738777` Release, verified the hash, and passed the budgets. With a tampered hash: exit 1, `sha256 mismatch`. |
| Takedown failure mode | Run. With `data/current-build.json` removed, `tools/fetch-data.ts` exits 1, so a deploy fails instead of shipping stale data (the Release and redeploy steps themselves were not exercised, to avoid taking the live site down). |
| Workflow lint | Run. `actionlint` clean on all workflows. |
| Prod rollback via `ref` input | Needs Malcolm: Actions → deploy → Run workflow, `promote` ticked, `ref` = a known-good SHA. Confirms the input and the checkout of an older commit. Also the first proof that prod deploys at all (Pages source must be GitHub Actions). |
| Merge queue | Needs Malcolm: import `.github/rulesets/main.json`, then watch one PR go through the queue (`ci.yml` runs on `merge_group`). |
| Dev rollback in Cloudflare | Needs Malcolm: Deployments → Rollback to this deployment, then roll forward again. |
| Lockfile bot end to end | Needs Malcolm: set `LOCKFILE_BOT_TOKEN`, then dispatch `lockfile` with a lockfile-conflicting PR open. |

Re-run the table after a change to any of these workflows, and append a dated section.
