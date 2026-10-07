# map-metadata — plan

## 1. Purpose & scope
Handles **user-submitted map metadata** — walkable regions, neutral creep camp locations, Sinner's Sacrifice locations, healing-orb spawns, and future kinds — and lets an admin **review, accept or reject** submissions. Accepted data becomes part of the published dataset consumed by the viewer and the query library.

**Non-goals:** not the viewer or the generic annotation tools (it plugs into them); not the query engine; not general user accounts.

## 2. Ownership boundary
`modules/map-metadata/**`, including `submit-worker/` (small serverless function) and the accepted data directory convention `data/metadata/<gameBuildId>/` (the module owns the tooling that writes there; data itself is committed by reviewed PRs).

## 3. Published surface
- **Panels**: `metadata.editor` (kind picker, per-kind forms, "my draft" list, validation messages, submit), `metadata.review` (**dev-only**: queue, diff view, accept/reject/request-changes), `metadata.history` (audit log, per-feature provenance). Registers per-kind tools into `ViewerService.registerTool` (e.g. "walkable polygon", "camp point") and read-only overlay layers for accepted/proposed/rejected data.
- Data files in the `MapMetadata` contract format: `data/metadata/<buildId>/<kind>.json` + a merged `metadata.bundle.json` (built by `bun run build:metadata`) with a content hash — the artifact the library and viewer load.
- CLI: `bun run metadata:validate`, `metadata:merge`, `metadata:rebase --from <build> --to <build>` (flags features that no longer fit a new map build).
- Submission endpoint contract (HTTP): `POST /submit` with a `Submission` JSON → creates a GitHub PR (or issue) labelled `metadata-submission`; response `{ id, url }`.

## 4. Uses
`contracts`: `MapMetadata`, `Annotation`, `ViewerService` tag (tools/overlays/picking), `MapBundle` (bounds + collision for geometric validation), `DevAuth` tag (review/merge rights via infra's GitHub proxy), `SelectionBus`, `ModuleDefinition`.

## 5. Technical design
**Feature kinds registry**: each kind = `{ id, label, geometryType, schema (Effect Schema), validators[], toolDefinition, style, uniqueness rule }` so new kinds are a single file. Initial kinds: `WalkableRegion` (polygon + `floorZ`, flags: walkable / interior / water / no-go), `CreepCamp` (point, tier/type, optional name), `SinnersSacrifice` (point), `HealingOrb` (point, respawn?), `Custom`.

**Authoring flow**: user opens editor → chooses kind → draws using viewer tools (snap to collision surface; Z auto-filled from raycast) → local draft persists in IndexedDB → "Review & submit" runs validation → submit.
- **Validation** (shared by editor, worker and review): schema; geometry (simple polygon, ≥ 3 vertices, area limits, within bounds, points on a surface within ε); semantic (camp not inside solid, duplicates within radius r of an existing accepted camp, overlapping walkable regions flagged); `gameBuildId` equals loaded bundle; size limits.

**Submission transport (D11)**: primary = Cloudflare Worker (`submit-worker/`): rate limits per IP and globally (no human check: nothing for the contributor to solve), re-validates with the same Effect Schema/validators (imported package), creates a branch + PR via a GitHub App/bot token (`data/submissions/<id>.json` — never touches `data/metadata/`). Fallback (no backend): "Download submission" JSON + prefilled GitHub issue link instructing to paste/attach. Both produce the same `Submission` document. No user accounts: provenance is a display name + optional GitHub handle (self-declared, marked unverified).

**Review flow (dev deployment only)**: calls GitHub only through the `DevAuth` proxy (the token never reaches the browser; D9). Queue = open PRs labelled `metadata-submission` (via GitHub API). Selecting one overlays proposed geometry on the map in a diff colour against accepted data, shows validation report, and per-feature accept/reject toggles with comment. **Accept** commits accepted records into `data/metadata/<buildId>/…` on the PR branch (status `accepted`, reviewer, date) and merges; **Reject** closes the PR with a reason comment. Everything is auditable in git. Bulk operations: accept all valid, reject all invalid.

**Data lifecycle**: `status` ∈ proposed/accepted/rejected/stale; on a new game build `metadata:rebase` re-validates accepted data against the new collision mesh and marks `stale` the ones that no longer fit; admin can re-confirm or move them. History preserved via git.

**Publish**: `metadata:merge` produces `metadata.bundle.json` (deterministic ordering, schema-validated, hash), copied by shell into the Pages artifact; library loads it through its `Data` layer.

**Anti-abuse**: size cap, per-IP + global rate limits, content validation, admin-only merge, no HTML/markdown rendered from user strings (text only).

## 6. Milestones
**Phasing:** Phase 3 — starts after Slice 1 and the spatial/nav work. Its role (D4): metadata supplies facts that cannot be derived (creep camps, Sinner's Sacrifice, healing-orb spawns if missing from the map entities) and **overrides** to the auto-generated navmesh (no-go/blocked regions, extra links such as ziplines, walkable corrections). It is no longer on the critical path of navigation queries.

| # | Deliverable | Acceptance |
|---|---|---|
| M0 | Scaffold; kinds registry; Effect Schemas consumed from contracts; validators with unit tests | `metadata:validate` accepts fixture, rejects crafted bad files |
| M1 | `metadata.editor` panel + kind tools via a mock `ViewerService` + IndexedDB drafts | Standalone harness: draw camp point & walkable polygon, reload, drafts persist |
| M2 | Integration with real viewer tools (snap to surface, Z fill) + overlays of accepted data | E2E in shell e2e (owned by shell; module provides test scenarios) |
| M3 | Submission document + download/issue fallback | Produces schema-valid `Submission`; issue link opens prefilled |
| M4 | `submit-worker` (rate-limit, PR creation) with local `wrangler dev` tests and mocked GitHub API | Contract tests: valid → PR created; invalid/over-limit → 4xx |
| M5 | `metadata.review` (dev-only): queue, diff overlay, per-feature accept/reject, merge/close via GitHub API | Integration test against a sandbox repo (opt-in) + mocked API in CI |
| M6 | `metadata:merge` publish bundle + `metadata:rebase` for new builds | Golden tests; stale detection demo |
| M7 | History/audit panel, bulk actions, polish, docs for contributors | Contributor guide in `docs/` inside the module |

## 7. Test strategy
Pure validators and merge logic heavily unit-tested (bun test); worker tested with `miniflare`/`wrangler` unit harness; UI via Playwright with mocked viewer + mocked GitHub API; review flow tested against recorded GitHub API fixtures.

## 8. Standalone mode
`bun run dev:standalone`: editor + review panels with `MockViewerService` (simple canvas) and mock GitHub backend seeded with fixture submissions.

## 9. Risks & open questions
- **[DECISION]** Is a Cloudflare Worker (third-party service) acceptable? Otherwise only the manual fallback is available.
- Quality control of crowd-sourced walkable regions: may need minimum-evidence rules (e.g. screenshot attachments, second-reviewer) — start with admin-only review.
- Navmesh override semantics (blocked polygons, added links, area cost multipliers) must be agreed with spatial-core/query-library via contracts requests before M0; overrides must be applied at query-load time (not by re-baking), so accepted data is picked up without re-running the extractor.
- Geometric validators rely on collision data being in the browser (bundle load) — keep validators runnable headless in the worker with only bounds checks as degraded mode.
- GitHub rate limits for review queue polling.

## 10. Definition of done
A contributor can draw and submit camps/regions on the live site; the admin can review and accept/reject on the dev site; accepted data is merged, published as `metadata.bundle.json`, and appears in the viewer and in query-library results; `metadata:rebase` handles a game update; all abuse controls in place; `MetadataEditor 1.0.0` frozen.
