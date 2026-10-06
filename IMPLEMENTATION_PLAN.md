# Deadlock Query — Technical Implementation Plan (rev 2)

Input: [PLAN.md](PLAN.md). This is the **high-level plan**. Each module has a folder under [`modules/`](modules/) with `PLAN.md` (stable spec), `STATE.md` (living progress log), `CLAUDE.md` (agent entry point) and `module.json`. Modules are built by **independent agents**; an agent must be able to start from its own folder plus `modules/contracts`.

**Rev 3 changes:** raycasting/physics library chosen (**three-mesh-bvh**, D15); `isInterior`/`isVisible`/`nearestWall` semantics are **user-authored** in a protected folder of `spatial-core` (agents provide primitives, stubs and tests-harness only); D8/D9/branch decisions resolved.

**Rev 2 changes (from review feedback):** queries are **TypeScript** (Monaco's TS language service gives the required suggestions; C#/Roslyn/WASM dropped); delivery is a **vertical slice first**, contracts grow from real data; heavy geometry is **baked offline**; navigation is **auto-generated** (Recast), user metadata only overrides/adds; module-to-module SemVer replaced by versioned *data formats* and a versioned *query API*; dev deployment uses a **real server-side password**; CI/tooling split out of `shell` into `infra`.

> **[VERIFY]** = external fact I could not confirm; settle by spike before relying on it. **[DECISION]** = needs a human call. **Resolved (rev 3):** D8 hosting derived geometry — accepted; D9 Cloudflare — accepted; branch = `main`; interior/visibility semantics are **written by the project owner** on top of a raycasting library (D15).

---

## 1. Product & fixed requirements

A public static website for spatial questions about the Deadlock map (Valve 6v6 third-person MOBA).

- **Query builder (main feature)**: user writes a line of **TypeScript** with intellisense *suggestions* (hard requirement) against a typed library; results show on the map and export to several formats. Free-form queries (any expression over the library, not a fixed menu). Examples: healing orbs within 10 s of a lane's guardian; wall-position pairs whose traversal distance is ≥ 2× the straight-line distance; neutral camps visible from high ground.
- **3D map viewer** with camera controls and annotation tools (OpenStreetMap-like).
- Local-only CLIs: map extraction (Source2Viewer) and in-game screenshots (console commands).
- User-submitted map metadata with admin review.
- Dev deployment behind a password with a **remote-usable Claude kanban**, features scoped to one module at a time.
- Stack: TypeScript, Effect.ts, Bun, GitHub Pages (prod). Visual modules are user-rearrangeable.

## 2. MVP (Slice 1) — "see/navigate the map in 3D and run one query"

Everything else is sequenced after this works end-to-end on the **public site**:

1. `dlq-extract` produces a real bundle (render GLB + collision + entities, one tile, no LOD).
2. Site shows the map; orbit/fly/top-down cameras.
3. Monaco editor with TS suggestions; run **one** query over entities (Euclidean/entity-only, e.g. *creep camps within 2000 units of a guardian*); results table + points on the map.
4. Deployed to Pages by CI; dev workflow (kanban → Claude → PR) works in parallel (Track B below).

Slice 1 deliberately excludes: navmesh, visibility, interior, annotation tools, screenshots, metadata, LOD/tiling, exports beyond CSV/JSON.

## 3. Modules (11)

| Module | Kind | Runs | Notes |
|---|---|---|---|
| [contracts](modules/contracts/PLAN.md) | TS schemas, service tags, fixtures | everywhere | **grows from spike findings**, small at first |
| [spatial-core](modules/spatial-core/PLAN.md) | TS lib: Vec3, BVH, raycast, grid, navmesh runtime, pathfinding | node + browser/worker | *new*; shared by extractor (bake), query-library, optionally viewer |
| [map-extractor](modules/map-extractor/PLAN.md) | Local CLI | dev machine w/ game | extraction **and bake** (BVH, navmesh, grids) |
| [screenshot-tool](modules/screenshot-tool/PLAN.md) | Local CLI | dev machine w/ game running | Phase 3 |
| [map-viewer](modules/map-viewer/PLAN.md) | Web panels (Three.js) | browser | |
| [query-library](modules/query-library/PLAN.md) | TS library (typed API + `.d.ts` + catalog) | worker | the user-facing query API |
| [query-builder](modules/query-builder/PLAN.md) | Web panels, Monaco TS, sandboxed runner | browser | main feature |
| [map-metadata](modules/map-metadata/PLAN.md) | Web panels + Worker + data | browser (+ dev review) | Phase 3 |
| [kanban](modules/kanban/PLAN.md) | Dev-only web panel + Actions | dev site | Track B |
| [shell](modules/shell/PLAN.md) | Web host: dockview layout, module list, services wiring | browser | slimmed down |
| [infra](modules/infra/PLAN.md) | CI/CD, repo tooling, deploy, dev gate/proxy, data releases | CI + Cloudflare | *new*, split from shell |

### Dependency rules
Modules import **only** `contracts` and (where listed in their `module.json` `dependsOn`) `spatial-core`. Web modules meet at runtime only through service tags in `contracts` composed by `shell`. Enforced by `infra`'s `check:deps` (dependency-cruiser). Allowed edges:

```
contracts  <- every module
spatial-core <- map-extractor, query-library, (map-viewer optional), (screenshot-tool optional: line-of-sight check when a baked bundle is given)
query-library -> consumed by query-builder as a built artifact (types .d.ts + runtime JS + apiCatalog.json), not by import
```

## 4. Architecture decisions

| # | Decision | Rationale / risk |
|---|---|---|
| D1 | **Queries are TypeScript.** Monaco's built-in TS language service runs in a worker with the library's `.d.ts` as an extra lib → completions, signature help, hover (TSDoc), diagnostics with zero server and zero large download. User code is transpiled with the same service and executed in an isolated Worker. | Replaces the Roslyn-WASM plan (huge, single-threaded, risky). Trade-off: not literal C#. |
| D2 | **User-facing query API is plain TypeScript, not Effect.** Internals may use Effect; the surface is arrays, iterables, classes with methods (`orb.position.nearestWall()`, `map.guardians.inLane("yellow")`). | Approachable one-liners; Effect stays in app/CLI code per PLAN.md. |
| D3 | **Bake heavy geometry offline** (extractor `bake`): serialized **three-mesh-bvh** over collision, **navmesh via Recast** (`recast-navigation-js`), and a generic 2D **sample grid** (floor heights, plus any per-cell values computed by the owner-authored semantics functions, e.g. interior flag / wall distance). Runtime queries use these + run Dijkstra/raycasts in a worker. Free-form is preserved because baked data are *primitives* the library composes, not canned answers. | Makes the "twice as far via traversal" query feasible in a browser. |
| D4 | **Navigation is auto-derived** from collision; user metadata supplies *overrides* (no-go regions, extra links such as ziplines) and non-derivable facts (camps, Sinner's Sacrifice). | Removes crowd-sourcing from the critical path. |
| D5 | **Canonical space: Source 2 world units, right-handed, Z-up.** GLBs declare a `glbToWorld` matrix. Conversion lives only in `contracts/Space`. | One space across tools. |
| D6 | **Data formats are versioned** with `schemaVersion` (semver) in every manifest; readers reject unknown majors with a clear message. Bundles are keyed by **game build id**. | Replaces module-to-module SemVer; deviation from PLAN.md's "modules use SemVer" is intentional — see §5.1. |
| D7 | **Query API is versioned** (`@deadlock-query/query-library` semver). Saved/shared queries store `apiVersion`; builder warns on major mismatch; deprecations live one major. Pre-1.0 may break. | Shared URLs must not silently rot. |
| D8 | **Hosted map data = `lite` tier** (simplified, untextured render mesh + collision + entities + baked data) stored as **GitHub Release assets** keyed by build id (not in git); the deploy workflow downloads them into the Pages artifact. **`full`** tier stays local. The viewer can also load a local bundle folder (File System Access API / drag-drop) for owners of the game. | CI has no game install, so bundles must come from somewhere; Releases avoid git bloat. **Decision (accepted):** host derived `lite` geometry publicly. Mitigations kept: no textures, decimated, derived data only, a documented takedown procedure (`docs/takedown.md`, owned by infra), and the pipeline must be able to un-publish a build by deleting its Release and redeploying. |
| D9 | **Dev deployment on Cloudflare Pages + Pages Functions** (prod stays GitHub Pages): a Function checks a password (secret in Cloudflare) and issues a signed HttpOnly session cookie; static dev assets and a `/api/github/*` proxy sit behind it. **The GitHub token lives only in the Function, never in the browser.** Kanban and metadata-review call the proxy. | GitHub Pages cannot do server-side auth; a client-side encrypted PAT is brute-forceable offline. **Decision (accepted):** Cloudflare. Fallback kept: GitHub Pages dev + token pasted into localStorage (passphrase-encrypted at rest, local only). Auth is behind a `DevAuth` service so either works. |
| D10 | **"Instruct Claude" = GitHub issue + `anthropics/claude-code-action`.** The kanban is a UI over issues/PRs (base: github-kanban). | github-kanban doesn't call Claude itself. |
| D11 | **Metadata submissions → PRs via a Cloudflare Worker** (Turnstile, rate limits), with a manual fallback (download JSON → issue). Review is dev-only. | Static site, auditable in git. |
| D12 | **Screenshots through the game's console over TCP** (`-netconport`) or RCON. **[VERIFY]** transport and commands; offline/sandbox only. | Phase 3; spike S3. |
| D13 | **Single root lockfile; module PRs may change `modules/<id>/**` plus `bun.lock`.** Lockfile conflicts are resolved by regenerating (`bun install`) in the merge queue/CI. | Fixes the earlier contradiction between workspaces and the one-module rule. |
| D14 | **Contracts emerge, not pre-designed.** After spike S2 reports what the real data looks like, contracts defines the minimum for Slice 1; additions follow each slice. A synthetic fixture generator exists for CI (no Valve data in CI) but must be validated against real extracted data by a local-only contract check. | Avoids designing interfaces against imagined data. |
| D15 | **Raycasting backend = `three-mesh-bvh`** (MIT) over the collision mesh: `raycast`/`raycastFirst`, `shapecast` (sphere/capsule/custom shape sweeps), `closestPointToPoint`, `intersectsSphere/Box`, serialisable BVH (`MeshBVH.serialize`) for baking, works in Workers/Bun, SharedArrayBuffer-friendly. Wrapped behind a small `Raycaster` interface in `spatial-core` so the backend is swappable. **`isInterior`, `isVisible`, `nearestWall` (and similar semantic predicates) are written by the project owner** in `modules/spatial-core/src/semantics/` using that interface; agents never author their bodies. | Chosen over Rapier/Jolt (full physics engines: heavier WASM, more than static-mesh queries need) and a custom BVH (more work, no gain). If later queries need character movement/step simulation, Rapier can be added behind the same interface. **[VERIFY]** version/API details and bundle size in spike S5. |
| D16 | **`main` is the default branch** (repo HEAD switched from `master`); `master` is never used. | Resolved. |

## 5. Cross-cutting conventions

### 5.1 Versioning (deliberate deviation from PLAN.md)
PLAN.md asks modules to use SemVer so they can depend on each other. In a monorepo that deploys atomically, per-module resolution adds machinery without benefit, so: `module.json` keeps an informational `version` + changelog in `STATE.md`; **SemVer is enforced where there is an external lifetime**: (a) data formats (`schemaVersion`), (b) the query API (D7), (c) CLI flags/exit codes of the two CLIs. If you want strict module SemVer + resolver back, it is an `infra` addition with no impact on other modules.

### 5.2 One module per change
A feature touches `modules/<id>/**` (+ `bun.lock`, D13). `infra` `check:scope` enforces; cross-module needs become separate issues, written first as a "Request" in the requester's `STATE.md`.

### 5.3 State for Claude
Each module: `CLAUDE.md` → `PLAN.md` → `STATE.md`. Agents update `STATE.md` in every PR (`check:state`).

### 5.4 Code conventions
TS strict; Effect `Schema` at IO boundaries; tagged errors; services as `Context.Tag` with Live/Test layers; each module has `bun run verify` (typecheck, lint, test, build) and a standalone dev mode against fixtures. Heavy/hot paths (BVH, raycasts, rendering) use typed arrays and plain functions, with Effect at the edges only.

### 5.5 Web module protocol
```ts
export interface ModuleDefinition {
  id: string
  layer: Layer.Layer<never, never, Requirements>   // services it provides
  panels: PanelDefinition[]                         // {id,title,component,defaultPlacement,minSize}
  commands?: CommandDefinition[]
}
```
`shell` mounts all panels in **dockview** (drag, split, tab, float, persist, reset, presets). Modules never own window chrome → uniform rearrangeability. The module list is a plain static file in `shell` (no runtime plugin resolution).

### 5.6 Shared types in `contracts` (grown per slice)
Slice 1: `MapBundle` manifest + entities, `QueryResult` (+CSV/JSON export), service tags `MapDataService`, `ViewerService`, `QueryEngine`, `SelectionBus`, `ModuleDefinition`. Later: `Annotation`, `MapMetadata`, `ScreenshotSet`, baked-data file specs (implemented in `spatial-core`).

## 6. Deployment
- **Prod** (GitHub Pages, `main`): shell + modules + `lite` bundle (downloaded from Release) + accepted metadata.
- **Dev** (Cloudflare Pages + Functions, auto-deploy from `main`/PR previews): same app plus dev-only panels, password session, GitHub proxy. "Promote to Prod" dispatches the prod workflow.
- Budgets: file ≤ 20 MB per tile; site ≤ 900 MB; first-load JS ≤ 1.5 MB gz excluding Monaco/map data (lazy load Monaco and bundle).

## 7. Delivery plan

**Phase 0 — Spikes (parallel, short; each ends with go/no-go in its `STATE.md`)**
- S1 (query-builder): Monaco TS worker with custom `.d.ts`, completions on a library class, transpile + run in sandboxed iframe→Worker, cancel via terminate. Gate: first suggestion ≤ 2 s after open; cancel ≤ 100 ms.
- S2 (map-extractor): Source2Viewer CLI → GLB/collision/entities for the Deadlock map **[VERIFY]**; document what exists (collision? entity classes? navmesh?).
- S3 (screenshot-tool, can slip to Phase 3): console transport feasibility.
- S4 (human): D8, D9 and branch decisions are **done** (accepted); D11 (metadata Worker) follows D9 and is accepted by implication.
- S5 (spatial-core): benchmark **three-mesh-bvh** in a Worker and in Bun on a 1 M-triangle synthetic scene (build, serialise/deserialise, 100 k rays, capsule shapecast); gate: build < 5 s in Bun, 100 k first-hit rays < 300 ms in a Worker, deserialise < 500 ms; write result in `STATE.md`. Fallback: Rapier (WASM trimesh colliders) or a custom BVH.

**Phase 1 — Slice 1 (two parallel tracks)**
- *Track A (product)*: contracts-min → extractor MVP, viewer MVP, library MVP, builder MVP, shell MVP, deploy.
- *Track B (dev workflow, enables remote development)*: infra (CI, scope-check, deploy, dev proxy/password) + kanban (board per module, issue → Claude Action → PR).
Exit: public URL shows the real map and runs one query; kanban can drive a module change end-to-end.

**Phase 2 — Spatial queries**: `spatial-core` raycasting backend + bake (collision BVH, sample grid, Recast navmesh); the owner writes `isInterior` / `isVisible` / `nearestWall` in `spatial-core/src/semantics/` while the agents wire them into library methods and the bake; library functions `travelTime/Distance` etc.; the three headline queries working; overlay styling by column; exports (CSV/JSON/GeoJSON/PNG); LOD/tiling; annotation tools.

**Phase 3 — Community & polish**: map-metadata (submit + review), screenshots (street-view markers), worker-pool parallel queries, example gallery, query sharing polish, bundle update workflow per game build.

## 8. Risks & open questions

1. Valve asset redistribution (D8) — accepted risk; takedown procedure required before first public publish.
2. What the Source2Viewer export actually yields for Deadlock (collision/entities/nav) — S2 decides scope of bake and entities.
3. Navmesh quality from raw collision (stairs, props, ziplines, jump pads) — human spot-check needed; metadata overrides exist for this reason.
4. Compute-heavy free-form queries in a browser (n² traversal): mitigated by baking + sampling + cancellation; true parallelism (worker pool + SharedArrayBuffer needs `coi-serviceworker` on GH Pages) is a Phase 3 stretch.
5. Cloudflare dependency for dev + submissions (D9, D11) — accepted.
6. Owner-authored semantics are on the critical path of headline queries 3 and any interior/visibility use: until written, library methods return clearly-marked placeholder results (see D15) — schedule this work before Phase 2 exit.
7. User-code safety: sandboxed iframe (opaque origin, meta CSP `connect-src 'none'`) + Worker; shared-URL queries never auto-run.

## 9. Per-module plan template
1. Purpose/scope/non-goals · 2. Ownership boundary · 3. Published surface · 4. Dependencies · 5. Technical design · 6. Milestones with acceptance (Slice 1 milestones first) · 7. Tests · 8. Standalone mode · 9. Risks/questions · 10. Definition of done.
