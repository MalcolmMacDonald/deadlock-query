# infra — state

- **Status:** M0+M1 done, M2 workflow written (needs Pages enabled), M4 live on Cloudflare (rate limit gap)
- **Version:** 0.0.0
- **Current milestone:** none (see PLAN.md §6)
- **Last updated:** 2026-10-05

## Done
- M0: root workspace, `new-module`, `verify:all`.
- M1: `check:scope/state/deps` (tools/lib/checks.ts, 6 tests), `ci.yml`, CODEOWNERS for `semantics/**`, claude/* semantics guard.

## In progress
- Docs from M7 started: `docs/secrets.md`, `docs/takedown.md`; root `NEXT.md` tracks next task per module.
- M2: `deploy.yml` + `tools/build.ts` (placeholder page until `modules/shell/dist` exists). Needs one-time human step: repo Settings → Pages → Source = GitHub Actions.

## M4 (code done, not yet live)
- `functions/_middleware.ts` + `functions/auth/{login,logout,session}.ts`, `modules/infra/src/auth.ts` (PBKDF2, HMAC session, rate limiter; 4 tests), `tools/hash-password.ts`, `wrangler.toml`, `dev` job in `deploy.yml` (skips until Cloudflare secrets exist), `docs/dev-site.md`.
- Verified live 2026-10-05: no cookie gives 302 to login (HTML) or 401 (assets); wrong password 401; right password 303 + cookie then site served.
- Gap found: the first in-memory rate limiter did not trigger (6+ rapid wrong attempts all 401; many isolates). Site is on a bare pages.dev (no zone, so no WAF). Replaced with a Cache API backed limiter (per data centre); to be re-verified live after deploy.

## Next
- Re-verify rate limit live after deploy, then M5 (GitHub proxy).
- M3 data release flow (after S2 produces a bundle); M4 needs a Cloudflare account + secrets.

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-05 — CI treats a `[infra]` PR title like the `infra` label (label is added after PR creation, so the first CI run raced it).

- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Decisions accepted: Cloudflare for dev (D9), hosting lite tier publicly (D8), branch `main`; add CODEOWNERS for semantics/ and takedown runbook.

- 2026-10-05 — Login rate limit uses the Workers Cache API (no KV setup; per data centre). PBKDF2 at 100k iterations (Workers cap).

## Open questions
- (see PLAN.md §9)
