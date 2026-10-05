# Next task per module

Single source for "what should I do next?". Prompt Claude with: **"Do the next task for <module>"** (or "pick any unblocked row"). Update the row in the same PR that completes it.

| Module | Next task | Blocked on |
|---|---|---|
| infra | M3 data release flow; M5 live (set `GITHUB_TOKEN_PROXY`); then M6 budgets/promote/previews | M3: a bundle from the extractor (M1). M5 live: PAT secret from Malcolm |
| contracts | M1 MapBundle/QueryResult/fixtures (S2 findings are in `modules/map-extractor/STATE.md`) | none |
| map-extractor | M1 open questions (see STATE.md); run `doctor` on dev machine | none (S2 done, GO; M0 done) |
| query-builder | S1 spike: Monaco TS worker + custom `.d.ts` + sandboxed run/cancel | none |
| spatial-core | S5 spike: three-mesh-bvh benchmark (1M tris, Bun + Worker) | none |
| query-library, map-viewer, shell | wait for contracts M1 | contracts M1 |
| kanban | wait for infra M5 live (`GITHUB_TOKEN_PROXY`) | infra |
| screenshot-tool, map-metadata | Phase 3 | — |

## Human-only steps
1. **Now:** repo Settings → Pages → Source = GitHub Actions.
2. ~~S2~~ done (2026-10-05).
3. **Cloudflare (M4):** create account + Pages project, then add the secrets listed in `docs/secrets.md`.

## Agent conventions
- Open a PR automatically when a task's work is pushed (no need to ask). Label `infra` for root/tooling changes; title prefixed `[<module-id>]`.
