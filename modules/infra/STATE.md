# infra — state

- **Status:** M0+M1 done, M2 workflow written (needs Pages enabled)
- **Version:** 0.0.0
- **Current milestone:** none (see PLAN.md §6)
- **Last updated:** 2026-10-05

## Done
- M0: root workspace, `new-module`, `verify:all`.
- M1: `check:scope/state/deps` (tools/lib/checks.ts, 6 tests), `ci.yml`, CODEOWNERS for `semantics/**`, claude/* semantics guard.

## In progress
- M2: `deploy.yml` + `tools/build.ts` (placeholder page until `modules/shell/dist` exists). Needs one-time human step: repo Settings → Pages → Source = GitHub Actions.

## Next
- M3 data release flow (after S2 produces a bundle); M4 needs a Cloudflare account + secrets.

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Decisions accepted: Cloudflare for dev (D9), hosting lite tier publicly (D8), branch `main`; add CODEOWNERS for semantics/ and takedown runbook.

## Open questions
- (see PLAN.md §9)
