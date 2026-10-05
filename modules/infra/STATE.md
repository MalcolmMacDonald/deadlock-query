# infra — state

- **Status:** M0+M1 done, M2 workflow written (needs Pages enabled), M4 live on Cloudflare
- **Version:** 0.0.0
- **Current milestone:** none (see PLAN.md §6)
- **Last updated:** 2026-10-05

## Done
- M0: root workspace, `new-module`, `verify:all`.
- M1: `check:scope/state/deps` (tools/lib/checks.ts, 6 tests), `ci.yml`, CODEOWNERS for `semantics/**`, claude/* semantics guard.

## In progress
- Docs from M7 started: `docs/secrets.md`, `docs/takedown.md`; root `NEXT.md` tracks next task per module.
- M2: `deploy.yml` + `tools/build.ts` (placeholder page until `modules/shell/dist` exists). Needs one-time human step: repo Settings → Pages → Source = GitHub Actions.

## M4 (done, live on Cloudflare)
- `functions/_middleware.ts` + `functions/auth/{login,logout,session}.ts`, `modules/infra/src/auth.ts` (PBKDF2, HMAC session; 3 tests), `tools/hash-password.ts`, `wrangler.toml`, `dev` job in `deploy.yml` (skips until Cloudflare secrets exist), `docs/dev-site.md`.
- Verified live 2026-10-05: no cookie gives 302 to login (HTML) or 401 (assets); wrong password 401; right password 303 + cookie then site served.

- Rate limiting: in-memory, Cache API and KV counters all failed to throttle live (KV binding did reach the function after declaring it in wrangler.toml, but counts never advanced). Removed the limiter; now a 1 s delay per failed login plus PBKDF2 and a random 20-char password. Hard limit later via Durable Object or WAF if needed.

## Next
- M4 done (login gate verified). Next: M5 GitHub proxy with allowlist + CSRF.
- M3 data release flow (after S2 produces a bundle).

## Blockers / Requests to other modules
- (none)

## Decisions log
- 2026-10-05 — CI treats a `[infra]` PR title like the `infra` label (label is added after PR creation, so the first CI run raced it).

- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).

- 2026-10-05 — Decisions accepted: Cloudflare for dev (D9), hosting lite tier publicly (D8), branch `main`; add CODEOWNERS for semantics/ and takedown runbook.

- 2026-10-05 — No per-IP login rate limit: only a 1 s failure delay (see M4 notes).

## Open questions
- (see PLAN.md §9)
