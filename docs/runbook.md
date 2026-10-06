# Runbook

Operations for the repo, the dev site and prod. Related: [rollback](rollback.md), [takedown](takedown.md), [secrets](secrets.md), [dev site](dev-site.md), [dry-run record](dry-run.md).

## How things move
| Thing | Trigger | Where it lands |
|---|---|---|
| PR checks | PR opened/updated, merge queue entry | `ci.yml` job `verify` (the one required check) |
| Dev site | every push to `main` | Cloudflare Pages `deadlock-query-dev` (`deploy.yml`, job `dev`) |
| Prod site | manual: Actions → deploy → Run workflow, `promote` ticked | GitHub Pages (`deploy.yml`, job `prod`) |
| PR preview | same-repo PR | `https://pr-<n>.deadlock-query-dev.pages.dev` (`preview.yml`) |
| Map data | PR that edits `data/current-build.json` | checked by `data.yml`, deployed with the next dev/prod build |
| Lockfile conflicts | push to `main` | `lockfile.yml` (needs `LOCKFILE_BOT_TOKEN`; otherwise follow "Lockfile conflicts" below) |

## Merging
`main` is protected by the ruleset in `.github/rulesets/main.json`: PR required, `verify` must pass, merge queue (merge commits), and owner review for `modules/spatial-core/src/semantics/**` (CODEOWNERS). Claude-opened PRs enable auto-merge right after opening; GitHub queues them once `verify` is green and merges them when the queue run is green. PRs touching `semantics/**` are left for Malcolm, and `check:scope` rejects them from `claude/*` branches anyway.

The queue runs `ci.yml` on the merge result (`merge_group` event), which includes `bun install --frozen-lockfile`. A PR whose lockfile is stale against `main` is ejected there instead of breaking `main`.

## Lockfile conflicts (D13)
Every module PR may change `bun.lock`, so two PRs adding dependencies will conflict on it. Regenerate, never hand-edit:

```
git fetch origin main
git merge origin/main            # stops on bun.lock
bun tools/resolve-lockfile.ts --commit
git push
```
The tool takes `main`'s lockfile, runs `bun install` against the merged `package.json` files, stages the result, and refuses (exit 1, nothing touched) if any other file conflicts. With the `LOCKFILE_BOT_TOKEN` secret set, `lockfile.yml` does exactly this for every open same-repo PR that conflicts after a push to `main`; PRs that conflict elsewhere get a warning in the workflow log.

## Promote to prod
1. Confirm the dev site on the commit you want looks right.
2. Actions → deploy → Run workflow → tick `promote`, leave `ref` empty (builds the dispatched branch, normally `main`).
3. Prod URL is shown on the run's `github-pages` environment. The run never gets cancelled by later pushes to `main`.

## Publish a new map bundle
Follow [dev-site.md → Publishing a new map bundle](dev-site.md#publishing-a-new-map-bundle). The PR that bumps `data/current-build.json` is checked by `data.yml`: it downloads every asset, verifies the sha256, unzips, and applies the site and tile budgets. Run the same check locally with `bun tools/check-data.ts`.
Never delete an old `data-<buildId>` Release unless it is a takedown; rollback depends on them.

## Rotate a secret
See [secrets.md](secrets.md) for where each lives. General order: create the new value, set it, redeploy (Cloudflare secrets only apply to the next deployment), verify, then revoke the old value.
- `SESSION_HMAC_KEY`: rotating signs everyone out. That is the intended emergency response to a leaked cookie.
- `DEV_PASSWORD_HASH`: `bun tools/hash-password.ts`, paste, redeploy.
- `GITHUB_TOKEN_PROXY`, `LOCKFILE_BOT_TOKEN`: create the new fine-grained PAT, replace, revoke the old PAT in GitHub settings.
- Suspected leak of any GitHub token: revoke first, then replace.

## Incidents
| Symptom | First action |
|---|---|
| Dev site broken after a merge | [Roll back dev](rollback.md#dev-site), then revert the merge on `main` |
| Prod site broken | [Roll back prod](rollback.md#prod-site) |
| Deploy fails with `sha256 mismatch` or `HTTP 404` on data | The Release asset changed or was deleted. [Roll back the data pointer](rollback.md#map-data) or re-publish |
| Build fails on a budget | Read the message (tile, site or initial JS); fix the data or lazy-load, do not raise the limit in `tools/lib/budget.ts` without a note in `modules/infra/STATE.md` |
| Content must come down (legal/D8) | [Takedown](takedown.md), target under 30 minutes |
| Login lockout / forgot password | Set a new `DEV_PASSWORD_HASH` and redeploy |
| `main` red | Revert the offending merge commit with a PR (`git revert -m 1 <sha>`); do not push to `main` |
| CI check name changed | Update the required check in `.github/rulesets/main.json` and the live ruleset together |

## One-time setup (Malcolm's hands)
1. Repo Settings → General → Pull Requests → enable **Allow auto-merge**.
2. Settings → Rules → Rulesets → New → **Import a ruleset** → `.github/rulesets/main.json`. This turns on the merge queue and requires `verify`. The admin role is a bypass actor so you can always merge by hand.
3. Optional: fine-grained PAT (Contents + Pull requests: read/write on this repo) as Actions secret `LOCKFILE_BOT_TOKEN` to enable the lockfile bot.
4. Existing items in [dev-site.md](dev-site.md) and [secrets.md](secrets.md) (Pages source, Cloudflare secrets, `GITHUB_TOKEN_PROXY`).
