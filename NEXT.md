# Next task per module

Single source for "what should I do next?". Prompt Claude with: **"Do the next task for <module>"** (or "pick any unblocked row"). Update the row in the same PR that completes it.

| Module | Next task | Blocked on |
|---|---|---|
| infra | `tools/build.ts`: pass `VITE_TARGET=<target>` to the shell build (`env: { ...process.env, VITE_TARGET: target }`); until then every deployed shell is a prod build, so a dev-only module will not show (or lock-screen) on the dev site (shell STATE.md, M4). M5 live (set `GITHUB_TOKEN_PROXY`, redeploy, verify). M0–M4, M6, M7 done in the repo (runbook, rollback, merge-queue ruleset, lockfile bot, `data.yml` gate); the ruleset, `lockfile.yml` and the prod rollback `ref` input still need a live dry run (`docs/dry-run.md`) | M5 live: PAT secret from Malcolm; M7 live: Malcolm imports the ruleset and enables auto-merge (`docs/runbook.md` one-time setup) |
| contracts | M4: `MapMetadata`, `ScreenshotSet`. M0–M3 done (typed `manifest.baked`, optional `Tile.lod`/`lodOf`, `check:real` covers baked files and LOD tiles). Malcolm: run `bun run check:real` on the real dl_midtown bundle on his machine. Follow-ups logged elsewhere: map-extractor should write `lod`/`lodOf`, map-viewer should draw only LOD0 tiles | none |
| map-extractor | Get walkable collision: `world_physics` holds only clip volumes, so the baked floor, `interior`, `wallDistance` and the navmesh describe clip lids (see STATE.md "Collision finding" for options). Lite pipeline otherwise verified on real `dl_midtown` (125 MB bundle). Then M5 sign-off, M6, and tune the lite triangle cut (5 M of 30 M) | Decision: collision source |
| query-builder | Only real-data leftovers remain (M0–M7 merged): buffer transfer/`NavMesh` loading in the worker, worker pool, real-network load numbers, gallery queries 1–3 on the real map (PLAN.md §10 done-check). Smaller: screen-reader pass, inlay hints, overlay styling by column, pinned result layers | real walkable data / real bake |
| spatial-core | Owner-written semantics (placeholders in `src/semantics/**`, Malcolm only; after editing them run `bun run semantics-version` in the module). M0–M5 and the nav leftovers are done (PR #76: `nearestPoint` grid index, funnel-smoothed `findPath`, `bun run bench:nav`, `Raycaster.triangle`, `SEMANTICS_VERSION`). Left: SampleGrid cost report and the real-map Dijkstra benchmark | Malcolm (semantics); real walkable data (benchmarks) |
| query-library | M6: metadata merge (camps/sacrifices/nav overrides) with provenance (M0–M5 done). Leftover: golden results for queries 1–3 and query 2 < 30 s on the real map | map-metadata / contracts shape for M6; real bake for goldens |
| map-viewer | M5 contracts side: `ViewerService` needs `registerTool` (request in STATE.md); then M6/M7 (SDF labels). M0–M4 and the M5 viewer side merged. Malcolm: >= 30 fps on the real bundle, 10k points at 60 fps, and tile streaming on the real dl_midtown bundle (real hardware) | contracts: `registerTool` on `ViewerService` |
| shell | M5 leftovers: a real Lighthouse accessibility run (>= 90; axe is clean) and keyboard resizing of panel groups. Then M2: swap the fixture for the real published bundle; ship `library.json` without the standalone editor app. M0–M5 merged | none |
| kanban | wait for infra M5 live (`GITHUB_TOKEN_PROXY`) | infra |
| screenshot-tool, map-metadata | Phase 3 | — |

## Human-only steps
1. **Now:** repo Settings → Pages → Source = GitHub Actions.
2. ~~S2~~ done (2026-10-05).
3. ~~Cloudflare (M4)~~ done (dev site live). Repo settings for infra M7: enable Allow auto-merge and import `.github/rulesets/main.json` (merge queue); optional `LOCKFILE_BOT_TOKEN` secret (see `docs/runbook.md`). Remaining secret: `GITHUB_TOKEN_PROXY` (infra M5 live); copy `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY` to the Preview environment for PR previews.

## Agent conventions
- Open a PR automatically when a task's work is pushed (no need to ask). Title prefixed `[<module-id>]`; root/tooling changes use the `[infra]` prefix (no label needed, `check:scope` treats the prefix like the `infra` label).
