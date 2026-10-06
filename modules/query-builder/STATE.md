# query-builder — state

- **Status:** M3 done
- **Version:** 0.0.0
- **Current milestone:** M3 complete; next is M4 (see PLAN.md §6)
- **Last updated:** 2026-10-06

## Done
- **S1 spike** (`spike/`, `src/sandbox/`, `bench/s1.ts`, `test/worker.test.ts`). Run `bun run bench` (needs Chromium via Playwright; builds the spike with `Bun.build`, serves it, drives it headless).

### S1 results (headless Chromium 1194, local server, Linux container, 2026-10-05)
| Gate | Target | Measured |
|---|---|---|
| First suggestion after editor open (`map.`) | ≤ 2000 ms | ~1100 ms (includes loading the 6 MB / 1.4 MB gz `ts.worker.js` from localhost) |
| Warm completion latency (`….position.` → `distanceTo`) | ≤ 200 ms | 116–134 ms (Playwright keypress → widget row, 5 ms polling) |
| Cancel infinite loop → replacement worker ready | ≤ 100 ms | 15–36 ms (5 trials) |

Also verified: library-class member completions with TSDoc signature, string-literal completions (`"yellow"` via Ctrl+Space), type errors surfaced by `getSemanticDiagnostics`, run of the emitted JS in the sandbox, timeout → terminate + respawn (500 ms test), worker still usable after cancel.

### Findings / decisions
- **Wrapper strategy:** the editor model is a plain script `file:///query.ts` (no import/export). JS comes from the TS worker's `getEmitOutput`; the sandbox worker takes the **completion value of an indirect `eval`**, so a trailing expression statement is the result. No AST rewrite, so diagnostics offsets stay exact. Thenables are awaited. Limits: no top-level `await`; a `const` declaration as the last statement yields `undefined`. Revisit in M1 if we want `return`/`await` support (would need an AST wrap after type-check).
- **Sandbox:** `<iframe sandbox="allow-scripts" srcdoc>` (opaque origin, confirmed cross-origin) with meta CSP `default-src 'none'; script-src 'nonce-…' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'`. The Worker is created from a blob inside the frame and inherits the CSP. Frame only accepts messages whose `source` is `parent`. `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`importScripts`/`indexedDB`/`caches`/`WebTransport` are redefined non-writable, non-configurable as `undefined` before user code (unit-tested in Bun; verified in Chromium).
- **Cancel:** parent → frame `cancel` → `worker.terminate()` + respawn; `ready` is posted once the new worker answers a ping. Timeout uses the same path. The frame's own thread stays free while the worker spins, so cancel is not blocked by the user loop.
- **Monaco bundling (Bun.build):** needs `editor.all.js` (suggest widget etc.), `basic-languages/typescript/typescript.contribution.js` (language registration; without it there is no highlighting and no TS worker), and `monaco.contribution.js` from `language/typescript`. `editor.worker.js` and `ts.worker.js` are built as separate entrypoints and found through `MonacoEnvironment.getWorkerUrl`. `ts.worker.js` is the dominant cost (6.1 MB min, ~1.4 MB gz); `entry.js` with `editor.all` is ~2.5 MB min (~0.87 MB gz). M6 should trim contributions and lazy-load.
- **Not covered (later milestones):** real library artifact (`index.d.ts`, runtime), transferring bundle buffers to the worker, row/memory caps, escape corpus (M3), warm numbers on a slow device or over a real network (first-suggestion budget is measured against local files only; CDN/Pages latency adds to it).

- **M0** (`src/app/`, `test/app.e2e.test.ts`). Standalone app: Monaco editor on `file:///query.ts` with the fixture `.d.ts` (`src/app/fixtureDts.ts`, copied from the S1 spike fixture), Run button / Ctrl+Enter, contracts `MockQueryEngine` driven through Effect (`engine.ts`), plain results table with stats and warnings (`resultsTable.ts`). `bun run dev:standalone` builds to `.app-dist/` and serves on :5173. Playwright e2e (skipped when no Chromium is found): type `map.` → suggestion list contains `spawnsOf`; run → table rows + stats.

- **M1** (`src/engine/`, `src/app/`, `test/engine.test.ts`, `test/project.test.ts`, `test/app.e2e.test.ts`). Real `QueryEngine` layer (`makeQueryEngine({ compiler, runner })`): compile via Monaco's TS worker (`monacoCompiler.ts`: syntactic+semantic diagnostics and `getEmitOutput` from the same service/`.d.ts` as completions), error diagnostics block the run (`line:col message`), JS runs in the sandbox, value projected to a `QueryResult` (`project.ts`). The library is consumed as a built artifact (`../query-library/dist`, read by `library.ts`; `buildApp` builds it first if missing): its ESM becomes the worker prelude (`toPrelude`: trailing `export {}` → globals + `__dlqLoad`), its `.d.ts` files plus a generated `globals.d.ts` shim make `map`, `meters`, `Vec3`… globals in the editor. The map bundle (`{manifest:{mapName,gameBuildId}, entities}`) is sent with `SandboxRunner.load`, remembered by the frame and replayed to every respawned worker. Standalone serves `library.json` + `bundle.json` (mini-map fixture) from `.app-dist/`. UI: live diagnostics markers (300 ms debounce), Run/Cancel buttons, error panel.
  - Acceptance met: slice-1 guardian→nearest-orb query returns the contracts fixture's `expectedGuardianOrbDistance` rows (unit test with a Worker + real library build, and Chromium e2e through the real editor); `while (true) {}` is stopped by timeout or cancel and the next query runs (also when cancel lands mid-compile).

- **M2** (`src/app/viewerIntegration.ts`, updated `src/app/resultsTable.ts` and `src/app/main.ts`). Extended `QueryResult` to include `rowIds`; updated `projectResult` to generate meaningful row IDs (entity ID if available, else row index). Created `viewerIntegration` module with `geometryToFeatures` (converts geometry columns to `OverlayFeature`s) and `setResultOverlay` (calls `ViewerService.setOverlay` for query geometry). Enhanced results table to support row selection with click handlers. Updated main app to:
  - Wire `MockViewerService` and `MockSelectionBus` layers
  - Track selected rows and re-render on selection
  - Call `setResultOverlay` after each query run
  - Pass `onRowSelect` callback to `renderResults` for interactivity
  - Acceptance met: rows are selectable, geometry is projected to overlay features with row-ID-based labels, mocks are in place for shell e2e integration.

- **M3** (`src/sandbox/limits.ts`, `src/sandbox/worker-source.ts`, `src/sandbox/frame.ts`, `src/sandbox/runner.ts`, `src/app/resultsTable.ts`, `test/adversarial.test.ts`, `test/sandbox.e2e.test.ts`). Safety hardening, in layers:
  - **Iframe/CSP:** `allow=""` and `referrerpolicy="no-referrer"` on the frame; CSP is now `script-src 'nonce-…' 'unsafe-eval'` (no `blob:`, so `import(blobUrl)` is blocked; `blob:` stays in `worker-src` only) plus `base-uri/form-action/frame-src 'none'`.
  - **Global scrub (worker):** in addition to the S1 list, `Worker`, `SharedWorker`, `BroadcastChannel`, `MessageChannel`, `RTCPeerConnection`, `Notification`, `postMessage`, `close`, `FileReaderSync`, `WebAssembly` and `navigator.{storage,locks,serviceWorker,sendBeacon}`. The worker captures `postMessage` first, so a query cannot forge protocol messages or spawn a child global that escapes the scrub. All non-writable/non-configurable.
  - **Run isolation:** timers (`setTimeout`/`setInterval`) a query leaves behind are cleared when the run settles; error reporting survives a hostile `toString` (previously a throwing `toString` hung the run until timeout).
  - **Caps** (`LIMITS`): rows 100 000 (cut inside the worker, real total reported as `totalRows` → warning "Result truncated to … of … rows"), result size 5 M values (strings weighted by length; over it the run fails with "Result is too large"), single allocation 256 MiB (`ArrayBuffer` + typed-array constructors via Proxy, incl. `.constructor`/`.from`, and `String.repeat/padStart/padEnd`; throws `RangeError … exceeds the sandbox limit`), results table renders only the first 2 000 rows (with a notice) until it is virtualised.
  - **Adversarial corpus:** `test/adversarial.test.ts` (Bun Worker, same worker source: global/constructor/Function escapes, scrub immutability, protocol forgery, loops, huge allocs, row/value caps, circular/DAG/hostile results) and `test/sandbox.e2e.test.ts` (real iframe + CSP in Chromium: opaque origin, no window/DOM/storage/network, `import()` of data:/blob:/https: blocked, nested Worker blocked, timeout + recovery, alloc refusal, row cap, render cap). Verified the Chromium corpus fails when the CSP is loosened.
  - **Known limits (accepted):** total heap use is not capped (only single allocations, the result, and the 30 s timeout); a query can poison built-in prototypes for later runs until the worker respawns (cancel/timeout); a microtask-flood after the result is posted starves the worker until the next run times out. Revisit with respawn-per-run or frozen intrinsics if needed.

## In progress
- (nothing)

## Next
- M4: Docs panel from `apiCatalog.json`, gallery with 3 PLAN.md queries, snippets, friendly errors (PLAN.md §6).

## Blockers / Requests to other modules
- None at this time. Shell e2e will wire the real `ViewerService` and `SelectionBus` from the module system.

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-05 — Show a "provisional semantics" banner when results carry the PLACEHOLDER_SEMANTICS flag.
- 2026-10-05 — S1: GO. Eval-completion-value wrapper, nonce+blob-worker sandbox, terminate-based cancel (details above).

- 2026-10-06 — M0: the e2e test lives in `bun test` (so `verify` covers it) but self-skips without Chromium. Mock results ignore the source, per `MockQueryEngine`. Results table is unvirtualised until a later milestone.

- 2026-10-06 — M1: result projection rules: array of arrays → columns `c1…`, array of objects → one column per key, scalars → `value`; 3-number arrays are `point`, longer lists of them `polyline`; objects with `id`+`position` (entities) become `entityRef` ids; mixed → `string`. Worker normalises with `toArray()` (Seq/Vec3) then plain objects. Rows capped at 100k with a warning until M3.
- 2026-10-06 — M1: default run timeout 30 s. Warnings from the TS service are shown as result warnings; any error diagnostic blocks the run. `await`/`return` at top level remain unsupported (S1 wrapper strategy kept).
- 2026-10-06 — M1: unit tests build the library JS straight from source into a temp dir and use `Bun.Transpiler` (no type-check) + a plain Worker; type-check paths are covered by the Chromium e2e only (self-skips without Chromium). The e2e needs `modules/query-library/dist` (built on demand by `buildApp`).

- 2026-10-06 — M2: Extended `QueryResult` schema to include `rowIds` field (array of strings, one per row). Row IDs are derived from entity.id if the original item is an entity, otherwise from row index. Feature labels are `{rowId}:{geometryColumnName}` to enable round-trip row selection ↔ feature highlight. Viewer overlay is keyed by `"query-result"` and set on every successful run (failures degrade gracefully with mock services). Selection bus integration is prepared for shell e2e where real services will replace mocks.

- 2026-10-06 — M3: limits live in one place (`LIMITS`) and are enforced in the worker first (cheapest), with `projectResult` and the table as backstops. Allocation guards are per-allocation, not cumulative, to avoid false positives on library churn. The `NEXT.md` row is not updated here: it is outside `modules/query-builder/` and `check:scope` rejects it, so it needs a follow-up infra change.

## Open questions
- (see PLAN.md §9)
