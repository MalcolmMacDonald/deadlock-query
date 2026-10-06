# Next task per module

Single source for "what should I do next?". Prompt Claude with: **"Do the next task for <module>"** (or "pick any unblocked row"). Update the row in the same PR that completes it.

| Module | Next task | Blocked on |
|---|---|---|
| infra | M5 live (set `GITHUB_TOKEN_PROXY`, redeploy, verify). M0–M4, M6, M7 done in the repo (runbook, rollback, merge-queue ruleset, lockfile bot, `data.yml` gate); the ruleset, `lockfile.yml` and the prod rollback `ref` input still need a live dry run (`docs/dry-run.md`) | M5 live: PAT secret from Malcolm; M7 live: Malcolm imports the ruleset and enables auto-merge (`docs/runbook.md` one-time setup) |
| contracts | M4: `MapMetadata`, `ScreenshotSet`. M0–M3 done (typed `manifest.baked`, optional `Tile.lod`/`lodOf`, `check:real` covers baked files and LOD tiles). Malcolm: run `bun run check:real` on the real dl_midtown bundle on his machine. Follow-ups logged elsewhere: map-extractor should write `lod`/`lodOf`, map-viewer should draw only LOD0 tiles | none |
| map-extractor | Get walkable collision: `world_physics` holds only clip volumes, so the baked floor, `interior`, `wallDistance` and the navmesh describe clip lids (see STATE.md "Collision finding" for options). Lite pipeline otherwise verified on real `dl_midtown` (125 MB bundle). Then M5 sign-off, M6, and tune the lite triangle cut (5 M of 30 M) | Decision: collision source |
| query-builder | M4: Docs panel from `apiCatalog.json`, gallery with the 3 PLAN.md queries, snippets, friendly errors (M0–M3 done; embeddable `makeQueryEditorPanel` shipped and wired into the shell) | none |
| spatial-core | Owner-written semantics (placeholders in `src/semantics/**`, Malcolm only; after editing them run `bun run semantics-version` in the module). M0–M5 and the nav leftovers are done (PR #76: `nearestPoint` grid index, funnel-smoothed `findPath`, `bun run bench:nav`, `Raycaster.triangle`, `SEMANTICS_VERSION`). Left: SampleGrid cost report and the real-map Dijkstra benchmark | Malcolm (semantics); real walkable data (benchmarks) |
| query-library | M6: metadata merge (camps/sacrifices/nav overrides) with provenance (M0–M5 done). Leftover: golden results for queries 1–3 and query 2 < 30 s on the real map | map-metadata / contracts shape for M6; real bake for goldens |
| map-viewer | M3 leftovers (multi-select, per-layer lock, label text), then M4 (M0–M3 mostly done; annotation tools and layers panel shipped, collision GLB drawn). Also: >= 30 fps on the real bundle and 10k points at 60 fps on real hardware (Malcolm's machine) | none |
| shell | M2 (rest): selection sync with a results panel; ship `library.json` without the standalone editor app. M0, M1 done; viewer, tools/layers panels, in-page query editor and the published `dl_midtown` bundle are wired | none (query-builder panel blocker resolved) |
| kanban | wait for infra M5 live (`GITHUB_TOKEN_PROXY`) | infra |
| screenshot-tool, map-metadata | Phase 3 | — |

## Human-only steps
1. **Now:** repo Settings → Pages → Source = GitHub Actions.
2. ~~S2~~ done (2026-10-05).
3. ~~Cloudflare (M4)~~ done (dev site live). Repo settings for infra M7: enable Allow auto-merge and import `.github/rulesets/main.json` (merge queue); optional `LOCKFILE_BOT_TOKEN` secret (see `docs/runbook.md`). Remaining secret: `GITHUB_TOKEN_PROXY` (infra M5 live); copy `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY` to the Preview environment for PR previews.

## Agent conventions
- Open a PR automatically when a task's work is pushed (no need to ask). Title prefixed `[<module-id>]`; root/tooling changes use the `[infra]` prefix (no label needed, `check:scope` treats the prefix like the `infra` label).
