# query-builder — state

- **Status:** S1 spike done — **GO**
- **Version:** 0.0.0
- **Current milestone:** S1 complete; next is M0 (see PLAN.md §6)
- **Last updated:** 2026-10-05

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

## In progress
- (nothing)

## Next
- M0: scaffold the real editor panel with fixture `.d.ts`, `MockQueryEngine`, results table (PLAN.md §6). Reuse `src/sandbox/` and the Bun.build recipe above.

## Blockers / Requests to other modules
- `NEXT.md` (root) still lists the S1 row as open; update it to "M0" in a follow-up outside this module (root files are out of scope for module PRs).

## Decisions log
- 2026-10-05 — Module scaffolded (rev 2 of IMPLEMENTATION_PLAN.md).
- 2026-10-05 — Show a "provisional semantics" banner when results carry the PLACEHOLDER_SEMANTICS flag.
- 2026-10-05 — S1: GO. Eval-completion-value wrapper, nonce+blob-worker sandbox, terminate-based cancel (details above).

## Open questions
- (see PLAN.md §9)
