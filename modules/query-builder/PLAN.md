# query-builder — plan

## 1. Purpose & scope
The main feature. The user writes TypeScript with **suggestions/intellisense** (hard requirement); the query runs in the browser inside an isolated worker; results show in a table and on the map and can be exported.

**Non-goals:** does not define query functions (query-library); does not render the map (uses `ViewerService`); no backend.

## 2. Ownership boundary
`modules/query-builder/**` (panels, runner, sandbox page). Consumes `query-library`'s built artifacts (`index.js`, `index.d.ts`, `apiCatalog.json`) copied in by the build, not imported as source.

## 3. Published surface
- `QueryEngine` service implementation (contracts): `status`, `check(source)` (diagnostics), `run(source, opts) → Stream<progress | result>`, `cancel(runId)`.
- Panels: `query.editor` (Monaco), `query.results` (virtualised table, sort/filter, stats, export menu), `query.docs` (searchable API catalog, click-to-insert), `query.gallery` (examples + saved queries; the 3 PLAN.md queries), `query.history`.
- Share links `#q=<lz-compressed source>&api=<apiVersion>` (never auto-run), save/load local, import/export `.dlq.json`.
- Exports via contracts `exportResult`: CSV, JSON, GeoJSON (Phase 2), annotation layer (Phase 2), PNG via viewer, clipboard.

## 4. Uses
`contracts` (`QueryResult`, `QueryEngine`, `ViewerService`, `MapDataService`, `SelectionBus`), query-library artifacts, `monaco-editor`.

## 5. Technical design

### 5.1 Suggestions (Monaco TS language service)
- Monaco's built-in TypeScript worker with `typescript.typescriptDefaults.addExtraLib(libraryDts)` + a global declaration file (`declare const map: MapContext; ...`). Provides completions (members, string-literal values like `"yellow"`), signature help, hover with TSDoc, inline diagnostics, go-to-definition into the `.d.ts`, quick info on overloads.
- **Query file model**: the editor holds a single virtual file `query.ts`; one-liners are valid expression statements — the runner wraps `return (<expr>)` only when the source is a single expression, otherwise treats it as a function body with explicit `return`. Diagnostics offsets are unaffected because wrapping is done after type-checking (the editor model is a module whose last expression statement is the result — see wrapper strategy in `STATE.md` after spike S1).
- Extras that go beyond default TS: completion item sorting favouring library members, snippet completions for common shapes (`withinTravelTime(...)`), parameter-name inlay hints, docs panel linked to hover, "insert example" gallery, error messages rewritten for common mistakes (e.g. forgetting `seconds()`), ctrl+space everywhere. Monaco loaded lazily (own chunk) and prefetched on idle; syntax highlighting works immediately while the TS worker spins up.

### 5.2 Execution & sandbox
```
Main thread ── postMessage (Schema-validated) ──> sandboxed <iframe sandbox="allow-scripts"> (opaque origin, meta CSP: default-src 'none'; script-src 'unsafe-eval' blob:; connect-src 'none')
                                                    └─ Worker(s) (blob, inherits CSP)  ← transpiled JS + query-library runtime + bundle ArrayBuffers
```
- Source is type-checked in Monaco's worker; JS is obtained via `getEmitOutput` (no extra compiler shipped).
- Runner scrubs worker globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB`, `caches`) before evaluating user code (defence in depth on top of CSP/opaque origin).
- **Cancel/timeout** (default 60 s, configurable): `worker.terminate()` + respawn (milliseconds, ~100 ms target) — preferable to cooperative-only. Cooperative `ctx.signal` supported for graceful partial results.
- Map data: the bundle's collision/BVH/grid/navmesh buffers are fetched once, held in the main thread, and **transferred/copied** to the worker; (Phase 3: SharedArrayBuffer + worker pool via `coi-serviceworker`).
- Row cap (default 100 k) + memory guard; progress events (`progress(f)` from the library) update a progress bar.
- **Result projection**: returned value → `QueryResult` (inferring columns from objects/tuples/entities; geometry from `Vec3`, entities with `position`, `[a,b]` pairs/segments, polygons) in a pure, unit-tested function.

### 5.3 Results ↔ map
Results carrying the library's `PLACEHOLDER_SEMANTICS` flag (owner-authored `isInterior`/`isVisible`/`nearestWall` not yet written, D15) are shown with a **"provisional semantics"** banner and the flag is included in exports' metadata.

After a run, geometry columns become a `FeatureCollection` sent via `ViewerService.setOverlay("query:<id>")`, coloured/sized by a user-chosen column; row hover/select ↔ feature highlight via `SelectionBus`; multiple pinned result layers; clear on new run unless pinned.

### 5.4 UX
Run (Ctrl+Enter), cancel, stats (check ms / run ms / rows), problems list, history, saved queries, example gallery, large-result paging, column filters, "copy as" menu, keyboard-only operable, dark theme matching shell.

## 6. Milestones
| # | Deliverable | Acceptance |
|---|---|---|
| **S1** (spike, first) | Monaco TS worker + custom `.d.ts` class completion; transpile + run in sandboxed iframe→Worker; terminate cancel; measure | Gates: first suggestion ≤ 2 s after panel open, completion latency ≤ 200 ms warm, cancel ≤ 100 ms; write-up in `STATE.md` incl. wrapper strategy |
| M0 | Scaffold; editor with fixture `.d.ts`; `MockQueryEngine`; results table w/ mock `QueryResult` | Playwright: type, see suggestions, run mock, see rows |
| M1 | **Slice 1**: real runner against library artifact + fixture bundle; diagnostics; projection; run/cancel | Slice-1 query returns expected rows; cancel an infinite loop works |
| M2 | Results ↔ viewer overlay + selection sync (with `MockViewerService`, then real in shell e2e) | E2E highlights rows ↔ points |
| M3 | Safety hardening + tests (global scrub, CSP, no network, row/mem caps) | Malicious corpus (fetch, import, eval escapes, infinite loop, huge alloc) neutralised |
| M4 | Docs panel from `apiCatalog.json`, gallery with 3 PLAN.md queries, snippets, friendly errors | Each catalog entry reachable from editor hover |
| M5 | Exports (CSV/JSON/GeoJSON/annotation/PNG), share links with `apiVersion` warning, saved queries/history | Round-trip tests; stale `apiVersion` shows warning |
| M6 | Perf/loading: lazy Monaco, caching, bundle-load progress, worker pool prep | Initial JS budget met; load UX documented |
| M7 | Accessibility & polish | Checklist in `STATE.md` |

## 7. Test strategy
Unit: wrapper logic, result projection, share-link codec, exports. Component/Playwright: suggestions appear (assert completion widget contents), run/cancel, sandbox escape corpus (adversarial tests are a first-class suite). Perf thresholds recorded.

## 8. Standalone mode
`bun run dev:standalone`: editor + results with fixture `.d.ts`, library artifact built locally from `query-library` output, mock viewer — no other running module required.

## 9. Risks & open questions
- Wrapping one-liners while keeping Monaco diagnostics/types exact (spike S1).
- Sandbox is "defence in depth", not a hard guarantee: opaque-origin iframe + CSP are the main barriers; shared-URL queries never auto-run; any future privileged data in the page (e.g. dev session) must never be reachable from the sandbox (dev panels live outside it).
- Very long-running queries block a single worker; parallelism is Phase 3.
- Suggestion quality depends on the library's types — coordinate via the catalog and type tests.

## 10. Definition of done
Typing in the editor yields rich suggestions and diagnostics; the three PLAN.md queries run on the real map; results show in table and map with exports; cancel/timeouts reliable; sandbox corpus green; load budgets met.
