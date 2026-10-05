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
- Gap found: in-memory limiter never triggered, and the Cache API limiter (PR #8) also never triggered live: Cache API is a no-op on pages.dev. Replaced with a KV-backed limiter (`RATE_LIMIT` binding); off until the binding exists. Re-verify live after Malcolm adds the binding.

- Header `x-ratelimit-store` stayed `none` with the dashboard binding, with or without wrangler.toml. Now declaring the KV namespace in wrangler.toml (`[[kv_namespaces]]`). Re-check header and 429 after deploy.

## Next
- Malcolm adds KV namespace + `RATE_LIMIT` binding; re-verify rate limit live, then M5 (GitHub proxy).
- M3 data release flow (after S2 produces a bundle); M4 needs a Cloudflare account + secrets.

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-05 — CI treats a `[infra]` PR title like the `infra` label (label is added after PR creation, so the first CI run raced it).

- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Decisions accepted: Cloudflare for dev (D9), hosting lite tier publicly (D8), branch `main`; add CODEOWNERS for semantics/ and takedown runbook.

- 2026-10-05 — Login rate limit uses KV (`RATE_LIMIT`); Cache API verified to not work on pages.dev. PBKDF2 at 100k iterations (Workers cap).

## Open questions
- (see PLAN.md §9)
