# shell — plan

## 1. Purpose & scope
The web app host: mounts every web module's panels in a **user-rearrangeable dockview layout**, wires module Effect Layers together, provides routing/theming/command palette, and hosts the dev lock screen. Intentionally thin; CI/CD and tooling live in `infra`.

**Non-goals:** no feature UI; no build/deploy logic; no dependency resolution between modules (static list).

## 2. Ownership boundary
`modules/shell/**` (Vite app, `src/modules.ts` static list, layout, services wiring).

## 3. Published surface
- The deployed web app (prod/dev targets via build flag from infra).
- `src/modules.ts`: the explicit list of `ModuleDefinition`s (edited by the shell agent when a module appears).
- `DevAuth` consumption: lock screen when `devOnly` panels are present and session is absent.

## 4. Uses
`contracts` (`ModuleDefinition`, `DevAuth`, service tags + mocks). Imports each web module's package entry (`index.ts` → `ModuleDefinition`) per `modules.ts`.

## 5. Technical design
- **Vite + React 18**; routes via hash (`#/`) for static hosting; lazy-load heavy panels (viewer, Monaco) with suspense fallbacks.
- **dockview**: drag/dock/split/tab/float/resize, layout persisted (localStorage, versioned schema), "Reset layout", named presets (Explore: viewer only; Query: viewer + editor + results; Review: viewer + metadata review), layout in URL hash optional share. Closed panels reopen via View menu / command palette (Ctrl+K).
- **Layer composition**: build one `ManagedRuntime` from all module Layers; a module whose Layer fails is replaced by an error panel, never a blank app. Services referenced via `contracts` tags, so panels from different modules talk only through `ViewerService`, `QueryEngine`, `SelectionBus`, etc.
- **Targets**: `prod` omits `devOnly` modules; `dev` includes them behind the lock screen.
- Theming (dark default), keyboard shortcuts registry, a11y baseline, global error boundary + toast service, "about/build info" panel (git SHA, game build id, library API version).
- Asset loading base path from env so prod (`/deadlock-query/`) and dev (`/`) work.

## 6. Milestones
| # | Deliverable | Acceptance |
|---|---|---|
| M0 | Vite app + dockview with two dummy panels from dummy modules; static `modules.ts` | Playwright: drag a panel, reload, layout restored |
| M1 | Layer composition + per-module error isolation + mock services from contracts | Failing module shows error panel, others live |
| M2 | **Slice 1 wiring**: viewer + query editor + results panels, default "Query" preset, lazy loading | Slice-1 e2e on fixture: load map, run mock/real query, rows appear and highlight on map |
| M3 | Layout presets, reset, command palette, share-layout link | E2E for each |
| M4 | Dev lock screen + `DevAuth` integration; dev-only panels | Hidden/locked in prod; usable after login in dev |
| M5 | Polish: theming, a11y (keyboard-only panel operation), about panel, error toasts | Lighthouse a11y ≥ 90 |

## 7. Test strategy
Playwright for layout and slice e2e (with fixture bundle, software GL); unit tests for layout (de)serialisation migrations.

## 8. Standalone mode
`bun run dev` with fixture + mock services and dummy panels — needs no other module.

## 9. Risks & open questions
- Panel-to-panel behaviour depends on service tags staying stable — coordinate via contracts `CHANGELOG.md`.
- Layout persistence versioning when panels are renamed.

## 10. Definition of done
Public site loads, panels rearrangeable and persisted, modules isolated from each other's failures, dev lock screen works, e2e slice test green.
