# map-viewer — agent entry point

3D map viewer: cameras, overlays, annotation tools; implements ViewerService.

## Read order
1. `PLAN.md` — this module's spec (scope, published surface, milestones, acceptance criteria).
2. `STATE.md` — current progress; continue at "Next".
3. `../contracts/` — the shared types you may import (and `../spatial-core/` only if listed in `module.json` `dependsOn`).
4. `../../IMPLEMENTATION_PLAN.md` §4–§5 for decisions and conventions.

## Rules
- Only modify files under `modules/map-viewer/` (plus `bun.lock` when adding dependencies). If another module needs a change — especially `contracts` — do NOT make it: record it under "Blockers / Requests" in `STATE.md` so a separate issue can be raised.
- Import only what `module.json` `dependsOn` allows. Develop against fixtures from `modules/contracts/`, never another module's running code.
- Versioning: data formats carry `schemaVersion` (bump major on breaking changes); the query API follows SemVer; CLI flags/exit codes are stable once 1.0. Module `version` in `module.json` is informational — bump it and note in `STATE.md`.
- Before finishing: run `bun run verify` and update `STATE.md` (done / next / blockers / decisions, date).
- TypeScript conventions: IMPLEMENTATION_PLAN.md §5.4 (Effect at IO/service edges, plain typed-array code on hot paths).
