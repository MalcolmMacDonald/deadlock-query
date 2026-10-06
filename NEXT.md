# Next task per module

Single source for "what should I do next?". Prompt Claude with: **"Do the next task for <module>"** (or "pick any unblocked row"). Update the row in the same PR that completes it.

| Module | Next task | Blocked on |
|---|---|---|
| infra | M5 live (set `GITHUB_TOKEN_PROXY`, redeploy, verify). M0–M4, M6 done; M5 code done; data publish helper (`tools/publish-data.ts`) not yet run on a real bundle | M5 live: PAT secret from Malcolm |
| contracts | M3: baked-data specs (adopt the real `manifest.baked` shape and a tile `lod` field; extend `check:real` to cover baked files and LOD tiles). M0–M2 done: `check:real` passes on the real dl_midtown bundle, no schema change needed | none |
| map-extractor | Get walkable collision: `world_physics` holds only clip volumes, so the baked floor, `interior`, `wallDistance` and the navmesh describe clip lids (see STATE.md "Collision finding" for options). Lite pipeline otherwise verified on real `dl_midtown` (125 MB bundle). Then M5 sign-off, M6, and tune the lite triangle cut (5 M of 30 M) | Decision: collision source |
| query-builder | M3: safety hardening + adversarial corpus, row/memory caps (M0–M2 done; Results ↔ viewer overlay wired to mocks) | none |
| spatial-core | Owner-written semantics (placeholders in `src/semantics/**`, Malcolm only). M0–M5 done; leftovers: navmesh funnel smoothing, spatial index for `NavMesh.nearestPoint`, Dijkstra benchmark, SampleGrid cost report on a real map | Malcolm (semantics); real bake (benchmarks) |
| query-library | M6: metadata merge (camps/sacrifices/nav overrides) with provenance (M0–M5 done). Leftover: golden results for queries 1–3 and query 2 < 30 s on the real map | map-metadata / contracts shape for M6; real bake for goldens |
| map-viewer | M3: annotation tools, layers panel (M0–M2 done; collision GLB drawn). Leftovers: >= 30 fps on the real bundle and 10k points at 60 fps on real hardware (Malcolm's machine) | none |
| shell | M2 (rest): rows highlight on the map; then swap fixture for the published bundle. M0, M1 done; viewer wired, Query preset, lazy editor | query-builder: embeddable editor panel (`makeQueryEditorPanel`) or an iframe postMessage protocol |
| kanban | wait for infra M5 live (`GITHUB_TOKEN_PROXY`) | infra |
| screenshot-tool, map-metadata | Phase 3 | — |

## Human-only steps
1. **Now:** repo Settings → Pages → Source = GitHub Actions.
2. ~~S2~~ done (2026-10-05).
3. ~~Cloudflare (M4)~~ done (dev site live). Remaining secret: `GITHUB_TOKEN_PROXY` (infra M5 live); copy `DEV_PASSWORD_HASH` and `SESSION_HMAC_KEY` to the Preview environment for PR previews.

## Agent conventions
- Open a PR automatically when a task's work is pushed (no need to ask). Label `infra` for root/tooling changes; title prefixed `[<module-id>]`.
