# Next task per module

Single source for "what should I do next?". Prompt Claude with: **"Do the next task for <module>"** (or "pick any unblocked row"). Update the row in the same PR that completes it.

| Module | Next task | Blocked on |
|---|---|---|
| infra | M5 live (set `GITHUB_TOKEN_PROXY`, redeploy, verify). M3, M4, M6 done; M5 code done | M5 live: PAT secret from Malcolm |
| contracts | M1 MapBundle/QueryResult/fixtures | S2 findings (human, local) |
| map-extractor | M1: settle the open questions in STATE.md "Next" (frame agreement, hulls, volume models, lite triangle cut, `.vents` parser). M0 code done; run `dlq-extract doctor` on the dev machine | Human: game install (local runs) |
| query-builder | M0: editor panel with fixture `.d.ts`, `MockQueryEngine`, results table (S1 done, GO) | none |
| spatial-core | M0: math, `Raycaster` interface + three-mesh-bvh impl, deterministic serialise tests (S5 done, GO) | none |
| query-library | M2: API snapshot test, example files with `@example` (M0+M1 done); M3 needs spatial-core | none |
| map-viewer | M1: Three.js scene, mini-map GLBs, Map/Orbit/Fly cameras, URL-hash state, Playwright smoke (M0 done) | none |
| shell | M1: layer composition, per-module error panels, contracts mocks (M0 done) | none |
| kanban | wait for infra M5 live (`GITHUB_TOKEN_PROXY`) | infra |
| screenshot-tool, map-metadata | Phase 3 | — |

## Human-only steps
1. **Now:** repo Settings → Pages → Source = GitHub Actions.
2. ~~S2~~ done (2026-10-05).
3. ~~Cloudflare (M4)~~ done (dev site live). Remaining secret: `GITHUB_TOKEN_PROXY` (infra M5 live); copy `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY` to the Preview environment for PR previews.

## Agent conventions
- Open a PR automatically when a task's work is pushed (no need to ask). Label `infra` for root/tooling changes; title prefixed `[<module-id>]`.
