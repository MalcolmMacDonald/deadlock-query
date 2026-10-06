# Takedown runbook (D8 mitigation; target < 30 min)

1. Delete the GitHub Release `data-<gameBuildId>` (and its tag).
2. Remove or blank `data/current-build.json` and commit to `main`.
3. Run the `deploy` workflow (prod and dev) so the published artifact no longer contains the bundle.
4. Purge Cloudflare Pages cache for the dev site; GitHub Pages cache expires after redeploy.
5. Record the incident and reason in `modules/infra/STATE.md`.

Rehearsal and related procedures: [runbook](runbook.md), [rollback](rollback.md), [dry-run record](dry-run.md). A deploy fails (rather than serving stale data) once the pointer is gone, so step 3 doubles as a check.
