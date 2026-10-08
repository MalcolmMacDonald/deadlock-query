# Next task per module

Single source for "what should I do next?". Prompt Claude with: **"Do the next task for <module>"** (or "pick any unblocked row"). Update the row in the same PR that completes it.

| Module | Next task | Blocked on |
|---|---|---|
| infra | M5 live (set `GITHUB_TOKEN_PROXY`, redeploy, verify). M0–M4, M6, M7 done in the repo (runbook, rollback, merge-queue ruleset, lockfile bot, `data.yml` gate); the ruleset, `lockfile.yml` and the prod rollback `ref` input still need a live dry run (`docs/dry-run.md`) | M5 live: PAT secret from Malcolm; M7 live: Malcolm imports the ruleset and enables auto-merge (`docs/runbook.md` one-time setup) |
| contracts | M0–M4 done (typed `manifest.baked`, `LOD`, `MapMetadata`, `ScreenshotSet`, `ViewerService.registerTool` required). Malcolm: run `bun run check:real` on the real dl_midtown bundle on his machine. New work arrives as requests from other modules (optional `captureImage` options `{ scale, transparent }` is the open one) | none |
| map-extractor | Navmesh sign-off: run `extract` (cheap `nav` stage) then `bake --force` on the dev machine and look at `<bundle>.qa/navmesh.obj`; pick the `.navflowmap` hull (`--flow-hull`, 0 unverified). Walkable floors and navmesh now come from the game's own `.nav` (PR #123: 47 % of grid cells have a real floor, was 6.7 %; 85 k polygons, 92 % in one component with links). Then `interior` (needs the `citadel_trigger_interior` volumes, `world_physics` cannot supply it), M6, and the lite triangle cut (5 M of 30 M) | A human looking at the OBJ |
| query-builder | Only real-data leftovers remain (M0–M7 merged): buffer transfer/`NavMesh` loading in the worker, worker pool, real-network load numbers, gallery queries 1–3 on the real map (PLAN.md §10 done-check). Smaller: screen-reader pass, inlay hints, overlay styling by column, pinned result layers | real walkable data / real bake |
| spatial-core | Owner-written semantics (placeholders in `src/semantics/**`, Malcolm only; after editing them run `bun run semantics-version` in the module). M0–M5 and the nav leftovers are done (PR #76: `nearestPoint` grid index, funnel-smoothed `findPath`, `bun run bench:nav`, `Raycaster.triangle`, `SEMANTICS_VERSION`). Left: SampleGrid cost report and the real-map Dijkstra benchmark | Malcolm (semantics); real walkable data (benchmarks) |
| query-library | M0–M7 done (`ctx.parallel` API with in-thread default, `mantle` default speed, goldens for queries 1–2 on the real map, query 2 ~2 s). Left: query 3 golden (needs owner semantics); worker `ParallelBackend` (query-builder) | Malcolm (semantics) for query 3 |
| map-viewer | M7: SDF labels and the performance pass (M0–M6 done; `registerTool` is on the service). Malcolm: >= 30 fps on the real bundle, 10k points at 60 fps, and tile streaming on the real dl_midtown bundle (real hardware) | none |
| shell | M5 done (Lighthouse accessibility 100, keyboard resizing of groups). M2: swap the fixture for the real published bundle; ship `library.json` without the standalone editor app. M0–M5 merged; the query editor is prefetched when idle | none |
| kanban | M0–M4 done on mocks (PRs #208, #210, #216, #218); the live GitHub path waits for infra M5 | live path: infra M5 |
| screenshot-tool | M0–M5 built against the fake console; `plan grid --above-floor <h>` now uses the baked navmesh floor (try it on the real bake). Only real-game checks remain | **Malcolm only, needs the game:** M0 acceptance `console "echo hi"` against real Deadlock (also settles spike S3: transport, launch options, screenshot folder, real `getpos` reply format), then the 20-shot acceptance run |
| map-metadata | M0–M7 done in the module (1.0.0-rc.2); shell mounts the editor, history and dev-only review panels. Left: infra proxy commit/merge/close routes, live worker config (Turnstile site key, allowed origin), real accepted data | infra (proxy routes); Malcolm (worker secrets) |

## Human-only steps
1. **Now:** repo Settings → Pages → Source = GitHub Actions.
2. ~~S2~~ done (2026-10-05).
3. ~~Cloudflare (M4)~~ done (dev site live). Repo settings for infra M7: enable Allow auto-merge and import `.github/rulesets/main.json` (merge queue); optional `LOCKFILE_BOT_TOKEN` secret (see `docs/runbook.md`). Remaining secret: `GITHUB_TOKEN_PROXY` (infra M5 live); copy `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY` to the Preview environment for PR previews.

## Agent conventions
- Open a PR automatically when a task's work is pushed (no need to ask). Title prefixed `[<module-id>]`; root/tooling changes use the `[infra]` prefix (no label needed, `check:scope` treats the prefix like the `infra` label).
