# Rollback

Pick the surface that is broken. Every path ends with a revert on `main` so the next push does not redeploy the bad change.

## Prod site
Prod only moves on a promote, so rolling back means promoting an older commit.
1. Find the last good commit: Settings → Environments → `github-pages` lists past deployments with their commit, or `git log --first-parent main`.
2. Actions → deploy → Run workflow: tick `promote`, set `ref` to that SHA (or tag/branch).
3. Check the prod URL. The older commit's `data/current-build.json` is used, so its Release must still exist (see "Map data").
4. Revert the bad merge on `main` (`git revert -m 1 <merge sha>` in a PR).

## Dev site
Fastest: Cloudflare dashboard → Workers & Pages → `deadlock-query-dev` → Deployments → pick the last good production deployment → **Rollback to this deployment**. That is immediate and needs no build. Then revert the bad merge on `main` (a merge to `main` redeploys dev). Secrets and environment variables are managed separately from deployments; see "Secrets".
Without the dashboard: revert the merge on `main`; the dev job redeploys in a few minutes.
PR previews (`pr-<n>`) are disposable; close the PR or push a fix.

## Map data
`data/current-build.json` pins a Release tag and hashes. To go back to the previous bundle, revert the PR that changed the pointer (or edit it back to the previous `buildId`, `tag`, hash), merge, and the next dev deploy (and the next promote for prod) uses it. This works only while the old asset still exists in its `data-<buildId>` Release, which is why Releases and their assets are kept (`publish-data` names assets by hash, so re-publishing never replaces one). `bun tools/check-data.ts` proves a pointer is deployable before you merge.
If the new bundle was never merged, nothing to roll back: close the PR (and delete its Release if unwanted).
Content that must disappear entirely is a [takedown](takedown.md), not a rollback.

## Code and workflows
Revert the merge commit with a PR. Workflow changes only take effect from `main`, so a bad `deploy.yml` is fixed by a revert PR; prod stays on its last promoted version meanwhile.

## Secrets
Cloudflare secrets apply from the next deployment, and a dashboard rollback does not restore an old secret value. If a rotated value is wrong, set the previous value again and redeploy. Keep the old value until the new one is verified. See [runbook → Rotate a secret](runbook.md#rotate-a-secret).

## Repo rules
If a ruleset change blocks merging, Malcolm can bypass as admin and fix it in Settings → Rules. `.github/rulesets/main.json` holds the intended state.
